/**
 * pi-image-classify - Image classification and cataloging extension
 * 
 * Uses the currently selected model in pi. If it doesn't support vision,
 * the API call will fail with an error telling the user to select a vision model.
 */

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, basename, extname } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const SUPPORTED_FORMATS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];
const DEFAULT_ASSET_FOLDER = "./assets/images";
const DEFAULT_CATALOG_FILE = "./assets/image_catalog.csv";
const NANOBANANA_OUTPUT = "./nanobanana-output";

// ============================================================================
// Helpers
// ============================================================================

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

function escapeCSV(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

// ============================================================================
// Classification
// ============================================================================

async function classifyWithVision(
  model: any,
  apiKey: string,
  imagePath: string,
  signal?: AbortSignal
): Promise<{ description: string; tags: string[] }> {
  const imageBuffer = await readFile(imagePath);
  const imageBase64 = imageBuffer.toString("base64");
  const mimeType = imagePath.endsWith(".png") ? "image/png" : "image/jpeg";
  
  const prompt = `Analyze this image and provide:
1. A SHORT description (70-140 characters) - capture the essence
2. Tags (comma-separated, max 10, single words)

Format: DESCRIPTION: [desc] TAGS: [tag1, tag2, ...]`;

  const text = await callVisionAPI(model, apiKey, imageBase64, mimeType, prompt, signal);
  return parseVisionResponse(text);
}

async function callVisionAPI(model: any, apiKey: string, imageBase64: string, mimeType: string, prompt: string, signal?: AbortSignal): Promise<string> {
  const provider = model.provider;
  
  if (provider === "google" || provider === "google-gemini-cli" || provider === "google-vertex" || provider === "google-antigravity") {
    const baseUrl = model.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
    const modelId = model.id.includes("gemini-2") ? model.id : "gemini-2.0-flash";
    const url = `${baseUrl}/models/${modelId}:generateContent?key=${apiKey}`;
    
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: imageBase64 } }] }],
        generationConfig: { maxOutputTokens: 256, temperature: 0.3 }
      }),
    });
    
    if (!response.ok) throw new Error(`API error: ${await response.text()}`);
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }
  
  if (provider === "anthropic") {
    const url = `${model.baseUrl || "https://api.anthropic.com"}/v1/messages`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      signal,
      body: JSON.stringify({
        model: model.id,
        max_tokens: 256,
        messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } }, { type: "text", text: prompt }] }]
      }),
    });
    
    if (!response.ok) throw new Error(`API error: ${await response.text()}`);
    const data = await response.json();
    return data.content?.[0]?.text || "";
  }
  
  if (provider === "openai") {
    const url = `${model.baseUrl || "https://api.openai.com/v1"}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      signal,
      body: JSON.stringify({
        model: model.id,
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } }, { type: "text", text: prompt }] }],
        max_tokens: 256,
      }),
    });
    
    if (!response.ok) throw new Error(`API error: ${await response.text()}`);
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  }
  
  // Fallback to Google Gemini format
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: imageBase64 } }] }],
      generationConfig: { maxOutputTokens: 256, temperature: 0.3 }
    }),
  });
  
  if (!response.ok) throw new Error(`API error: ${await response.text()}`);
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

function parseVisionResponse(text: string): { description: string; tags: string[] } {
  const descMatch = text.match(/DESCRIPTION:\s*(.+?)(?:\n|$)/i);
  const tagsMatch = text.match(/TAGS:\s*(.+?)(?:\n|$)/i);
  
  let description = descMatch?.[1]?.trim() || "Image description unavailable";
  let tagsStr = tagsMatch?.[1]?.trim() || "";
  
  if (description.length > 140) description = description.substring(0, 137) + "...";
  if (description.length < 70) description = description.padEnd(70);
  
  let tags = tagsStr.split(",").map(t => t.trim().toLowerCase()).filter(t => t);
  if (tags.length === 0) {
    tags = description.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 10);
  }
  
  return { description, tags: [...new Set(tags)].slice(0, 10) };
}

// ============================================================================
// Catalog Management
// ============================================================================

interface CatalogEntry {
  filename: string;
  description: string;
  tags: string;
  source: string;
  dateAdded: string;
  filepath: string;
}

async function loadCatalog(catalogPath: string): Promise<CatalogEntry[]> {
  const entries: CatalogEntry[] = [];
  if (!existsSync(catalogPath)) return entries;
  
  const content = await readFile(catalogPath, "utf-8");
  const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("#") && !l.startsWith("filename"));
  
  for (const line of lines) {
    const parts = parseCSVLine(line);
    if (parts.length >= 5) {
      entries.push({ filename: parts[0], description: parts[1], tags: parts[2], source: parts[3], dateAdded: parts[4], filepath: parts[5] || parts[0] });
    }
  }
  return entries;
}

async function saveCatalog(catalogPath: string, entries: CatalogEntry[]): Promise<void> {
  const header = "filename,description,tags,source,date_added,filepath";
  const lines = entries.map(e => [escapeCSV(e.filename), escapeCSV(e.description), escapeCSV(e.tags), escapeCSV(e.source), e.dateAdded, escapeCSV(e.filepath)].join(","));
  await writeFile(catalogPath, [header, ...lines].join("\n") + "\n", "utf-8");
}

function entryExists(entries: CatalogEntry[], filepath: string): boolean {
  return entries.some(e => e.filepath === filepath || e.filename === basename(filepath));
}

function searchEntries(entries: CatalogEntry[], query: string, limit: number = 10): CatalogEntry[] {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/);
  
  return entries
    .map(entry => {
      let score = 0;
      const descLower = entry.description.toLowerCase();
      const tagsLower = entry.tags.toLowerCase();
      const filenameLower = entry.filename.toLowerCase();
      
      if (filenameLower.includes(queryLower)) score += 10;
      for (const word of queryWords) {
        if (tagsLower.includes(word)) score += 5;
        if (descLower.includes(word)) score += 2;
      }
      return { entry, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.entry);
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
  
  // --------------------------------------------------------------------------
  // Tool: classify_image
  // --------------------------------------------------------------------------
  pi.registerTool({
    name: "classify_image",
    label: "Classify Image",
    description: "Classify a single image: generate description (70-140 chars) and tags, add to catalog CSV. Uses the currently selected model.",
    parameters: Type.Object({
      file: Type.String({ description: "Path to the image file to classify" }),
      description: Type.Optional(Type.String({ description: "Manual description override" })),
      tags: Type.Optional(Type.String({ description: "Manual comma-separated tags" })),
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
      
      const entries = await loadCatalog(catalogPath);
      if (entryExists(entries, filepath)) {
        return { content: [{ type: "text", text: `Already cataloged: ${basename(filepath)}` }], details: { alreadyExists: true } };
      }
      
      if (!ctx.model) throw new Error("No model selected. Use /model to select a vision-capable model.");
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(ctx.model.provider);
      if (!apiKey) throw new Error(`No API key for ${ctx.model.provider}. Configure it in settings.`);
      
      onUpdate?.({ content: [{ type: "text", text: `Analyzing with ${ctx.model.provider}/${ctx.model.id}...` }] });
      
      let description = params.description || "";
      let tags: string[] = [];
      
      if (!description && !params.tags) {
        const result = await classifyWithVision(ctx.model, apiKey, filepath, signal);
        description = result.description;
        tags = result.tags;
      } else {
        if (description) {
          if (description.length > 140) description = description.substring(0, 137) + "...";
          if (description.length < 70) description = description.padEnd(70);
        }
        if (params.tags) tags = params.tags.split(",").map(t => t.trim()).filter(t => t);
      }
      
      const entry: CatalogEntry = {
        filename: basename(filepath),
        description,
        tags: tags.join(", "),
        source: params.source || "manual",
        dateAdded: new Date().toISOString().split("T")[0],
        filepath,
      };
      
      entries.push(entry);
      await saveCatalog(catalogPath, entries);
      
      return {
        content: [{ type: "text", text: `Classified: ${description}\nTags: ${entry.tags}` }],
        details: { catalogPath, entry, totalEntries: entries.length },
      };
    },
  });

  // --------------------------------------------------------------------------
  // Tool: classify_folder
  // --------------------------------------------------------------------------
  pi.registerTool({
    name: "classify_folder",
    label: "Classify Folder",
    description: "Batch classify all images in a folder. Uses the currently selected model.",
    parameters: Type.Object({
      folder: Type.Optional(Type.String({ description: "Folder path (default: ./assets/images)" })),
      source: Type.Optional(Type.String({ description: "Source label for all images" })),
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
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(ctx.model.provider);
      if (!apiKey) throw new Error(`No API key for ${ctx.model.provider}. Configure it in settings.`);
      
      const entries = await loadCatalog(catalogPath);
      const newImages = images.filter(img => !entryExists(entries, img)).slice(0, params.limit || undefined);
      const skipped = images.length - newImages.length;
      
      if (newImages.length === 0) {
        return { content: [{ type: "text", text: `All ${images.length} images already cataloged.` }], details: { imagesFound: images.length, skipped, totalEntries: entries.length } };
      }
      
      onUpdate?.({ content: [{ type: "text", text: `Classifying ${newImages.length} images with ${ctx.model.provider}/${ctx.model.id}...` }] });
      
      const results: CatalogEntry[] = [];
      let classified = 0;
      
      for (const imagePath of newImages) {
        try {
          onUpdate?.({ content: [{ type: "text", text: `Classifying ${basename(imagePath)} (${classified + 1}/${newImages.length})...` }] });
          
          const result = await classifyWithVision(ctx.model, apiKey, imagePath, signal);
          
          const entry: CatalogEntry = {
            filename: basename(imagePath),
            description: result.description,
            tags: result.tags.join(", "),
            source: params.source || "batch",
            dateAdded: new Date().toISOString().split("T")[0],
            filepath: imagePath,
          };
          
          entries.push(entry);
          results.push(entry);
          classified++;
        } catch (error) {
          console.error(`Failed to classify ${imagePath}:`, error);
        }
      }
      
      await saveCatalog(catalogPath, entries);
      
      return {
        content: [{
          type: "text",
          text: `Classified ${classified} images:\n${results.map(r => `- ${r.filename}: ${r.description}`).join("\n")}${skipped > 0 ? `\n\nSkipped ${skipped} already-cataloged images` : ""}`
        }],
        details: { catalogPath, classified, skipped, results, totalEntries: entries.length },
      };
    },
  });

  // --------------------------------------------------------------------------
  // Tool: search_images
  // --------------------------------------------------------------------------
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
          text: `Found ${results.length} images:\n${results.map(r => `- ${r.filename}\n  "${r.description}"\n  Tags: ${r.tags}`).join("\n\n")}`
        }],
        details: { query: params.query, matches: results.length, totalEntries: entries.length, results },
      };
    },
  });

  // --------------------------------------------------------------------------
  // Tool: suggest_images
  // --------------------------------------------------------------------------
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

  // --------------------------------------------------------------------------
  // Tool: sync_nanobanana
  // --------------------------------------------------------------------------
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

  // --------------------------------------------------------------------------
  // Tool: get_catalog_stats
  // --------------------------------------------------------------------------
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
          text: `Image Catalog:\n- Total: ${entries.length}\n- Folder: ${DEFAULT_ASSET_FOLDER}\n- File: ${catalogPath}\n\nBy source:\n${Object.entries(sources).map(([src, count]) => `- ${src}: ${count}`).join("\n")}`
        }],
        details: { totalEntries: entries.length, sources, catalogPath },
      };
    },
  });

  // --------------------------------------------------------------------------
  // Command: /classify
  // --------------------------------------------------------------------------
  pi.registerCommand("classify", {
    description: "Classify images in ./assets/images/ and add to catalog",
    handler: async (args, ctx) => {
      if (!ctx.model) {
        ctx.ui.notify("No model selected. Use /model first.", "warning");
        return;
      }
      ctx.ui.notify(`Classifying with ${ctx.model.provider}/${ctx.model.id}...`, "info");
      ctx.sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: `Use classify_folder with folder="./assets/images"` }],
        timestamp: Date.now(),
      });
    },
  });
}
