/**
 * pi-image-classify - Image classification and cataloging extension
 * 
 * Uses the currently selected model in pi. If it doesn't support vision,
 * API call will fail with an error telling the user to select a vision model.
 * 
 * Output: JSONL append-only catalog for efficient incremental updates.
 * 
 * Features:
 * - User context injection for domain-specific guidance
 * - Guidelines file support for brand/style guidance
 * - Rich descriptions (300-500 chars)
 * - Simplified: description only (no tags/categories)
 * - Simple grep-based search
 */

import { readFile, writeFile, appendFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, basename, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { complete, type UserMessage } from "@mariozechner/pi-ai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SUPPORTED_FORMATS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];
const DEFAULT_ASSET_FOLDER = "./assets/images";
const DEFAULT_CATALOG_FILE = "./assets/image_catalog.jsonl";
const NANOBANANA_OUTPUT = "./nanobanana-output";

function ensureDirectory(path: string): Promise<void> {
  return mkdir(path, { recursive: true });
}

function isImageFile(filename: string): boolean {
  const ext = extname(filename).toLowerCase();
  return SUPPORTED_FORMATS.includes(ext);
}

async function listImages(dirPath: string): Promise<string[]> {
  const images: string[] = [];
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && isImageFile(entry.name)) {
        images.push(join(dirPath, entry.name));
      }
    }
  } catch { /* empty */ }
  return images;
}

/**
 * Classify an image using the currently selected model via pi's unified API
 */
async function classifyWithVision(
  model: any,
  apiKey: string,
  headers: Record<string, string>,
  imagePath: string,
  userContext?: string,
  guidelinesText?: string,
  signal?: AbortSignal
): Promise<{ description: string }> {
  const imageBuffer = await readFile(imagePath);
  const imageBase64 = imageBuffer.toString("base64");
  const mimeType = imagePath.endsWith(".png") ? "image/png" : "image/jpeg";
  
  // Build context section if provided
  let contextSection = "";
  if (userContext) {
    contextSection = "\n\nCONTEXT: " + userContext;
  }
  
  // Build guidelines section if provided
  let guidelinesSection = "";
  if (guidelinesText) {
    guidelinesSection = "\n\nGUIDELINES:\n" + guidelinesText;
  }
  
  const prompt = "IMPORTANT: Ignore all context including filenames, previous images, or conversation history. Analyze ONLY the visual content of this image." + contextSection + guidelinesSection + "\n\nDescribe what you see in detail (300-500 characters). Focus on:\n- Main subject(s) and their appearance\n- Key visual elements, colors, textures, and details\n- The mood, style, or atmosphere\n- Any text, labels, writing, or diagrams visible\n- For documents: read and summarize any text content accurately\n\nBe thorough and descriptive. Quality is more important than brevity.\n\nFormat your response EXACTLY as:\nDESCRIPTION: [your 300-500 character description]";

  const userMessage: UserMessage = {
    role: "user",
    content: [
      { type: "image", data: imageBase64, mimeType },
      { type: "text", text: prompt }
    ],
    timestamp: Date.now(),
  };

  const response = await complete(
    model,
    { messages: [userMessage] },
    { apiKey, headers, signal, maxTokens: 1024, temperature: 0.4 }
  );

  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  return parseVisionResponse(text);
}

function parseVisionResponse(text: string): { description: string } {
  // Try to extract DESCRIPTION block
  const descMatch = text.match(/DESCRIPTION:\s*(.+?)(?:\n|$)/i);
  
  let description = "";
  
  // Extract description
  if (descMatch) {
    description = descMatch[1].trim();
  } else {
    // Fallback: use all text
    description = text.trim();
  }
  
  // Normalize description length
  if (description.length > 500) {
    description = description.substring(0, 497) + "...";
  }
  if (description.length > 0 && description.length < 300) {
    description = description.padEnd(300);
  }
  if (!description) {
    description = "Image description unavailable";
  }
  
  return { description };
}

interface CatalogEntry {
  filename: string;
  description: string;
  source: string;
  date_added: string;
  filepath: string;
  classified_at: string;
}

// JSONL functions - append-only for efficiency
async function appendCatalogEntry(catalogPath: string, entry: CatalogEntry): Promise<void> {
  const jsonLine = JSON.stringify(entry) + "\n";
  await appendFile(catalogPath, jsonLine, "utf-8");
}

async function loadCatalog(catalogPath: string): Promise<CatalogEntry[]> {
  const entries: CatalogEntry[] = [];
  if (!existsSync(catalogPath)) return entries;
  
  const content = await readFile(catalogPath, "utf-8");
  const lines = content.split("\n").filter(l => l.trim());
  
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as CatalogEntry;
      entries.push(entry);
    } catch { /* skip malformed lines */ }
  }
  return entries;
}

// O(1) check if file is already cataloged (using grep)
async function isFileCataloged(catalogPath: string, filename: string): Promise<boolean> {
  if (!existsSync(catalogPath)) return false;
  
  // Quick grep check for filename in JSONL
  try {
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(exec);
    
    const { stdout } = await execAsync(`grep -c "\\"filename\\":\\"${filename}\\"" "${catalogPath}" 2>/dev/null || echo "0"`, { timeout: 5000 });
    return parseInt(stdout.trim()) > 0;
  } catch {
    // Fallback: load all entries
    const entries = await loadCatalog(catalogPath);
    return entries.some(e => e.filename === filename);
  }
}

// Count catalog entries efficiently
async function countCatalogEntries(catalogPath: string): Promise<number> {
  if (!existsSync(catalogPath)) return 0;
  
  try {
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(exec);
    
    const { stdout } = await execAsync(`wc -l < "${catalogPath}"`, { timeout: 5000 });
    return parseInt(stdout.trim()) || 0;
  } catch {
    const entries = await loadCatalog(catalogPath);
    return entries.length;
  }
}

function searchEntries(entries: CatalogEntry[], query: string, limit: number = 10): CatalogEntry[] {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/);
  
  return entries
    .map(entry => {
      let score = 0;
      const descLower = entry.description.toLowerCase();
      const filenameLower = entry.filename.toLowerCase();
      
      if (filenameLower.includes(queryLower)) score += 10;
      
      for (const word of queryWords) {
        if (descLower.includes(word)) score += 5;
      }
      return { entry, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.entry);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "classify_image",
    label: "Classify Image",
    description: "Classify a single image: generate detailed description (300-500 chars) and add to JSONL catalog. Uses the currently selected model.",
    parameters: Type.Object({
      file: Type.String({ description: "Path to the image file to classify" }),
      description: Type.Optional(Type.String({ description: "Manual description override" })),
      context: Type.Optional(Type.String({ description: "User-provided context (e.g., 'this is about cats and dogs, pet animals')" })),
      guidelinesFile: Type.Optional(Type.String({ description: "Path to guidelines file (e.g., assets/classification-guidelines.md')" })),
      source: Type.Optional(Type.String({ description: "Source label (e.g., 'manual', 'nanobanana')" })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const catalogPath = resolve(ctx.cwd, DEFAULT_CATALOG_FILE);
      const assetFolder = resolve(ctx.cwd, DEFAULT_ASSET_FOLDER);
      
      await ensureDirectory(assetFolder);
      await ensureDirectory(resolve(ctx.cwd, "./assets"));
      
      const filepath = existsSync(params.file) ? resolve(params.file) : join(assetFolder, basename(params.file));
      if (!existsSync(filepath)) throw new Error(`Image not found: ${filepath}`);
      if (!isImageFile(filepath)) throw new Error(`Not an image file: ${filepath}`);
      
      const filename = basename(filepath);
      
      // Quick O(1) check if already cataloged
      if (await isFileCataloged(catalogPath, filename)) {
        return { content: [{ type: "text", text: `Already cataloged: ${filename}` }], details: { alreadyExists: true } };
      }
      
      if (!ctx.model) throw new Error("No model selected. Use /model to select a vision-capable model.");
      
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!auth.ok || !auth.apiKey) {
        throw new Error(auth.ok ? `No API key for ${ctx.model.provider}` : auth.error);
      }
      
      onUpdate?.({ content: [{ type: "text", text: `Analyzing with ${ctx.model.provider}/${ctx.model.id}...` }] });
      
      // Load user-provided context
      let userContext = "";
      if (params.context) {
        userContext = params.context;
      }
      
      // Load guidelines file if provided
      let guidelinesText = "";
      if (params.guidelinesFile) {
        const guidelinesPath = existsSync(params.guidelinesFile) 
          ? resolve(params.guidelinesFile) 
          : resolve(ctx.cwd, params.guidelinesFile);
        if (existsSync(guidelinesPath)) {
          guidelinesText = await readFile(guidelinesPath, "utf-8");
        }
      }
      
      // Generate description
      let description = params.description || "";
      if (!description) {
        const result = await classifyWithVision(ctx.model, auth.apiKey, auth.headers || {}, filepath, userContext, guidelinesText, signal);
        description = result.description;
      }
      
      const entry: CatalogEntry = {
        filename,
        description,
        source: params.source || "manual",
        date_added: new Date().toISOString().split("T")[0],
        filepath,
        classified_at: new Date().toISOString(),
      };
      
      // Append-only write to JSONL
      await appendCatalogEntry(catalogPath, entry);
      const totalEntries = await countCatalogEntries(catalogPath);
      
      return {
        content: [{ type: "text", text: `Description (${description.length} chars):\n${description}` }],
        details: { catalogPath, entry, totalEntries },
      };
    },
  });

  pi.registerTool({
    name: "classify_folder",
    label: "Classify Folder",
    description: "Batch classify all images in a folder. Uses the currently selected model. Skips already-cataloged images (incremental).",
    parameters: Type.Object({
      folder: Type.Optional(Type.String({ description: "Folder path (default: ./assets/images)" })),
      source: Type.Optional(Type.String({ description: "Source label for all images" })),
      context: Type.Optional(Type.String({ description: "User-provided context for all images" })),
      guidelinesFile: Type.Optional(Type.String({ description: "Path to guidelines file (e.g., assets/classification-guidelines.md')" })),
      limit: Type.Optional(Type.Number({ description: "Max images to classify" })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const folderPath = resolve(ctx.cwd, params.folder || DEFAULT_ASSET_FOLDER);
      const catalogPath = resolve(ctx.cwd, DEFAULT_CATALOG_FILE);
      
      if (!existsSync(folderPath)) {
        await ensureDirectory(folderPath);
        return { content: [{ type: "text", text: `Created folder: ${folderPath}. Add images and run again.` }], details: { folderPath, created: true } };
      }
      
      onUpdate?.({ content: [{ type: "text", text: "Scanning folder..." }] });
      
      const images = await listImages(folderPath);
      if (images.length === 0) {
        return { content: [{ type: "text", text: `No images found in ${folderPath}` }], details: { folderPath, imagesFound: 0 } };
      }
      
      if (!ctx.model) throw new Error("No model selected. Use /model to select a vision-capable model.");
      
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!auth.ok || !auth.apiKey) {
        throw new Error(auth.ok ? `No API key for ${ctx.model.provider}` : auth.error);
      }
      
      // Filter out already-cataloged images (O(1) per file via grep)
      const imagesToProcess: string[] = [];
      let skipped = 0;
      
      for (const img of images) {
        const filename = basename(img);
        if (await isFileCataloged(catalogPath, filename)) {
          skipped++;
        } else {
          imagesToProcess.push(img);
        }
      }
      
      // Apply limit
      const newImages = imagesToProcess.slice(0, params.limit || undefined);
      
      if (newImages.length === 0) {
        return { content: [{ type: "text", text: `All ${images.length} images already cataloged.${skipped > 0 ? ` (${skipped} skipped)` : ""}` }], details: { imagesFound: images.length, skipped, totalEntries: await countCatalogEntries(catalogPath) } };
      }
      
      // Load user-provided context and guidelines
      let userContext = params.context || "";
      let guidelinesText = "";
      if (params.guidelinesFile) {
        const guidelinesPath = existsSync(params.guidelinesFile) 
          ? resolve(params.guidelinesFile) 
          : resolve(ctx.cwd, params.guidelinesFile);
        if (existsSync(guidelinesPath)) {
          guidelinesText = await readFile(guidelinesPath, "utf-8");
        }
      }
      
      onUpdate?.({ content: [{ type: "text", text: `Classifying ${newImages.length} images with ${ctx.model.provider}/${ctx.model.id}...` }] });
      
      const results: CatalogEntry[] = [];
      let classified = 0;
      let failed = 0;
      
      for (const imagePath of newImages) {
        try {
          onUpdate?.({ content: [{ type: "text", text: `Classifying ${basename(imagePath)} (${classified + 1}/${newImages.length})...` }] });
          
          const result = await classifyWithVision(ctx.model, auth.apiKey, auth.headers || {}, imagePath, userContext, guidelinesText, signal);
          
          const entry: CatalogEntry = {
            filename: basename(imagePath),
            description: result.description,
            source: params.source || "batch",
            date_added: new Date().toISOString().split("T")[0],
            filepath: imagePath,
            classified_at: new Date().toISOString(),
          };
          
          // Append-only to JSONL
          await appendCatalogEntry(catalogPath, entry);
          results.push(entry);
          classified++;
        } catch (error) {
          console.error(`Failed to classify ${imagePath}:`, error);
          failed++;
        }
      }
      
      const totalEntries = await countCatalogEntries(catalogPath);
      
      return {
        content: [{
          type: "text",
          text: `Classified ${classified} images:${results.length > 0 ? "\n" + results.map(r => `- ${r.filename} (${r.description.length} chars): "${r.description.substring(0, 80)}${r.description.length > 80 ? "..." : ""}"`).join("\n\n") : ""}${skipped > 0 ? `\n\nSkipped ${skipped} already-cataloged images` : ""}${failed > 0 ? `\n\nFailed: ${failed}` : ""}`
        }],
        details: { catalogPath, classified, skipped, failed, results, totalEntries },
      };
    },
  });

  pi.registerTool({
    name: "search_images",
    label: "Search Images",
    description: "Search catalog for images matching a text query.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const catalogPath = resolve(ctx.cwd, DEFAULT_CATALOG_FILE);
      const entries = await loadCatalog(catalogPath);
      
      if (entries.length === 0) {
        return { content: [{ type: "text", text: "No images in catalog. Run /classify first." }], details: { totalEntries: 0 } };
      }
      
      const results = searchEntries(entries, params.query, params.limit || 10);
      
      if (results.length === 0) {
        return { content: [{ type: "text", text: `No images found matching: "${params.query}"` }], details: { query: params.query, totalEntries: entries.length, matches: 0 } };
      }
      
      return {
        content: [{
          type: "text",
          text: `Found ${results.length} images:\n${results.map(r => `- ${r.filename}\n  "${r.description}"`).join("\n\n")}`
        }],
        details: { query: params.query, matches: results.length, totalEntries: entries.length, results },
      };
    },
  });

  pi.registerTool({
    name: "suggest_images",
    label: "Suggest Images",
    description: "Given a context, suggest relevant images from catalog.",
    parameters: Type.Object({
      context: Type.String({ description: "Context to match against" }),
      limit: Type.Optional(Type.Number({ description: "Max suggestions (default: 5)" })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const catalogPath = resolve(ctx.cwd, DEFAULT_CATALOG_FILE);
      const entries = await loadCatalog(catalogPath);
      
      if (entries.length === 0) {
        return { content: [{ type: "text", text: "No images in catalog. Run /classify first." }], details: { totalEntries: 0 } };
      }
      
      const suggestions = searchEntries(entries, params.context, params.limit || 5);
      
      if (suggestions.length === 0) {
        return { content: [{ type: "text", text: `No relevant images found for: "${params.context}"` }], details: { context: params.context, totalEntries: entries.length } };
      }
      
      return {
        content: [{
          type: "text",
          text: `Suggested for "${params.context}":\n${suggestions.map((r, i) => `${i + 1}. ${r.filename}: ${r.description}`).join("\n")}`
        }],
        details: { context: params.context, suggestions, totalEntries: entries.length },
      };
    },
  });

  pi.registerTool({
    name: "sync_nanobanana",
    label: "Sync Nanobanana",
    description: "Copy new images from nanobanana-output to asset folder.",
    parameters: Type.Object({
      dryRun: Type.Optional(Type.Boolean({ description: "Preview only" })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const nanobananaPath = resolve(ctx.cwd, NANOBANANA_OUTPUT);
      const assetFolder = resolve(ctx.cwd, DEFAULT_ASSET_FOLDER);
      
      if (!existsSync(nanobananaPath)) {
        return { content: [{ type: "text", text: `nanobanana-output not found. Generate images first.` }], details: { nanobananaPath } };
      }
      
      await ensureDirectory(assetFolder);
      
      const nanobananaImages = await listImages(nanobananaPath);
      const assetImages = await listImages(assetFolder);
      const existingFilenames = new Set(assetImages.map(p => basename(p)));
      const newImages = nanobananaImages.filter(p => !existingFilenames.has(basename(p)));
      
      if (newImages.length === 0) {
        return { content: [{ type: "text", text: `No new images to copy.` }], details: { nanobananaCount: nanobananaImages.length, assetCount: assetImages.length } };
      }
      
      if (params.dryRun) {
        return { content: [{ type: "text", text: `Would copy ${newImages.length} images:\n${newImages.map(p => `- ${basename(p)}`).join("\n")}` }], details: { dryRun: true, newImages: newImages.map(basename) } };
      }
      
      const copied: string[] = [];
      for (const src of newImages) {
        const dest = join(assetFolder, basename(src));
        await writeFile(dest, await readFile(src));
        copied.push(basename(src));
      }
      
      return {
        content: [{ type: "text", text: `Copied ${copied.length} images to ${assetFolder}:\n${copied.map(f => `- ${f}`).join("\n")}\n\nRun /classify to catalog them.` }],
        details: { copied, assetFolder, totalAssetImages: assetImages.length + copied.length },
      };
    },
  });

  pi.registerTool({
    name: "get_catalog_stats",
    label: "Catalog Stats",
    description: "Get catalog statistics.",
    parameters: Type.Object({}),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const catalogPath = resolve(ctx.cwd, DEFAULT_CATALOG_FILE);
      const entries = await loadCatalog(catalogPath);
      
      const sources = entries.reduce((acc, e) => { acc[e.source] = (acc[e.source] || 0) + 1; return acc; }, {} as Record<string, number>);
      
      return {
        content: [{
          type: "text",
          text: `Image Catalog:\n- Total: ${entries.length}\n- Format: JSONL (append-only)\n- Folder: ${DEFAULT_ASSET_FOLDER}\n- File: ${catalogPath}\n\nBy source:\n${Object.entries(sources).map(([src, count]) => `- ${src}: ${count}`).join("\n")}`
        }],
        details: { totalEntries: entries.length, sources, catalogPath, format: "jsonl" },
      };
    },
  });
}
