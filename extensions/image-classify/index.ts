/**
 * pi-image-classify - Image classification and cataloging extension
 * 
 * Uses the currently selected model in pi. If it doesn't support vision,
 * the API call will fail with an error telling the user to select a vision model.
 * 
 * Output: JSONL append-only catalog for efficient incremental updates.
 * 
 * Features:
 * - Category-first classification with reusable category list
 * - Explicit context ignore to prevent filename bias
 * - Tag-based search with relevance scoring
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
const CATEGORIES_FILE = join(__dirname, "data", "categories.json");

function ensureDirectory(path: string): Promise<void> {
  return mkdir(path, { recursive: true });
}

interface CategoriesData {
  categories: string[];
  created_at: string;
  version: string;
}

async function loadCategories(): Promise<string[]> {
  if (!existsSync(CATEGORIES_FILE)) {
    // Fallback to default categories if file doesn't exist
    return ["uncategorized", "art", "nature", "people", "animal", "technology", "industrial", "food", "travel", "architecture"];
  }
  
  try {
    const content = await readFile(CATEGORIES_FILE, "utf-8");
    const data = JSON.parse(content) as CategoriesData;
    return data.categories || [];
  } catch {
    // Fallback on parse error
    return ["uncategorized", "art", "nature", "people", "animal", "technology", "industrial", "food", "travel", "architecture"];
  }
}

async function saveCategories(categories: string[]): Promise<void> {
  const data: CategoriesData = {
    categories,
    created_at: new Date().toISOString().split("T")[0],
    version: "1.0",
  };
  
  await ensureDirectory(dirname(CATEGORIES_FILE));
  await writeFile(CATEGORIES_FILE, JSON.stringify(data, null, 2), "utf-8");
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
  signal?: AbortSignal
): Promise<{ description: string; tags: string[]; category: string }> {
  const imageBuffer = await readFile(imagePath);
  const imageBase64 = imageBuffer.toString("base64");
  const mimeType = imagePath.endsWith(".png") ? "image/png" : "image/jpeg";
  
  const categories = await loadCategories();
  const categoryList = categories.slice(0, 20).join(", ") + "..."; // Show first 20 to avoid overwhelming the prompt
  
  const prompt = `IMPORTANT: Ignore all context including filenames, previous images, or conversation history. Analyze ONLY the visual content of this image.

FIRST: Describe what you see in detail (200-300 characters). Focus on:
- Main subject(s) and their appearance
- Key visual elements, colors, and details
- The mood, style, or atmosphere
- Any text, labels, or writing visible

SECOND: Based on your description, select the BEST category from:
${categoryList}

If NONE fit perfectly, create a NEW category that is:
- Specific (e.g., "blueprint" instead of "industrial")
- Singular form (use "building" not "buildings")
- One or two words maximum

THIRD: Generate exactly 8 DIVERSE tags from what you observed
- Include: subject, action, setting/context, style/mood, content-type
- Do NOT include the category as a tag (unless it's also descriptive like "blueprint")
- Use 1-2 word phrases where meaningful (e.g., "pressure-gauge" not just "gauge")

Format your response EXACTLY as:
CATEGORY: [your selected or created category]
DESCRIPTION: [your 200-300 character description]
TAGS: [tag1, tag2, tag3, tag4, tag5, tag6, tag7, tag8]`;

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
    { apiKey, headers, signal, maxTokens: 512, temperature: 0.4 }
  );

  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  return parseVisionResponse(text, categories);
}

function parseVisionResponse(text: string, categories: string[]): { description: string; tags: string[]; category: string } {
  // Try to extract CATEGORY, DESCRIPTION and TAGS blocks
  const catMatch = text.match(/CATEGORY:\s*(.+?)(?:\n|$)/i);
  const descMatch = text.match(/DESCRIPTION:\s*(.+?)(?:\n|$)/i);
  const tagsMatch = text.match(/TAGS:\s*(.+?)(?:\n|$)/i);
  
  let category = "";
  let description = "";
  let tagsStr = "";
  
  // Extract category
  if (catMatch) {
    category = catMatch[1].trim().toLowerCase();
    // Ensure singular form
    category = category.replace(/s$/, "");
  }
  
  // Extract description
  if (descMatch) {
    description = descMatch[1].trim();
  } else {
    // Fallback: try to extract first substantial line
    const lines = text.split("\n").filter(l => l.trim().length > 20);
    if (lines.length > 0) {
      description = lines[0].replace(/^[^a-zA-Z]*/, "").trim();
    }
  }
  
  // Extract tags
  if (tagsMatch) {
    tagsStr = tagsMatch[1];
  } else {
    // Fallback: extract last line if it looks like tags
    const lines = text.split("\n");
    const potentialTagsLine = lines[lines.length - 1];
    if (potentialTagsLine && (potentialTagsLine.includes(",") || potentialTagsLine.includes("|"))) {
      tagsStr = potentialTagsLine;
    }
  }
  
  // If no category found, try to infer from tags/description or use "uncategorized"
  if (!category) {
    const descLower = description.toLowerCase();
    for (const cat of categories) {
      if (descLower.includes(cat) || tagsStr.toLowerCase().includes(cat)) {
        category = cat;
        break;
      }
    }
    if (!category) category = "uncategorized";
  }
  
  // Normalize description length
  if (description.length > 300) {
    description = description.substring(0, 297) + "...";
  }
  if (description.length > 0 && description.length < 200) {
    description = description.padEnd(200);
  }
  if (!description) {
    description = "Image description unavailable";
  }
  
  // Parse and clean tags
  let tags = tagsStr
    .split(/[,|]/)
    .map(t => t.trim().toLowerCase().replace(/[^\w\-]/g, "").trim())
    .filter(t => t.length > 1 && t.length < 30);
  
  // Remove category from tags (if present)
  tags = tags.filter(t => t !== category);
  
  // Ensure exactly 8 tags, diverse
  if (tags.length < 8) {
    // Extract words from description as fallback tags
    const descWords = description
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3 && !["the", "this", "that", "with", "from", "have", "been", category].includes(w));
    const uniqueWords = [...new Set(descWords)];
    for (const word of uniqueWords) {
      if (!tags.includes(word) && tags.length < 8) {
        tags.push(word);
      }
    }
  }
  
  // Remove duplicates and limit to 8
  tags = [...new Set(tags)].slice(0, 8);
  
  // If still no tags, use generic
  if (tags.length === 0) {
    tags = ["uncategorized", "image", "photo", "visual", "graphic", "content", "media", "asset"];
  }
  
  return { description, tags, category };
}

interface CatalogEntry {
  filename: string;
  description: string;
  tags: string;
  category: string;
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
    
    const { stdout } = await execAsync(`grep -c "\"filename\":\"${filename}\"" "${catalogPath}" 2>/dev/null || echo "0"`, { timeout: 5000 });
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
      const tagsLower = entry.tags.toLowerCase();
      const catLower = entry.category.toLowerCase();
      const filenameLower = entry.filename.toLowerCase();
      
      // Category match gets highest score
      if (catLower.includes(queryLower) || queryLower.includes(catLower)) score += 15;
      
      // Filename match
      if (filenameLower.includes(queryLower)) score += 10;
      
      // Tag matches
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

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "classify_image",
    label: "Classify Image",
    description: "Classify a single image: generate category, detailed description (200-300 chars), and exactly 8 diverse tags, add to JSONL catalog. Uses the currently selected model.",
    parameters: Type.Object({
      file: Type.String({ description: "Path to the image file to classify" }),
      description: Type.Optional(Type.String({ description: "Manual description override" })),
      tags: Type.Optional(Type.String({ description: "Manual comma-separated tags (max 8)" })),
      category: Type.Optional(Type.String({ description: "Manual category override" })),
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
      
      let description = params.description || "";
      let tags: string[] = [];
      let category = params.category || "";
      
      if (!description && !params.tags && !params.category) {
        const result = await classifyWithVision(ctx.model, auth.apiKey, auth.headers || {}, filepath, signal);
        description = result.description;
        tags = result.tags;
        category = result.category;
        
        // If new category was created, add to categories file
        const categories = await loadCategories();
        if (!categories.includes(category) && category !== "uncategorized") {
          categories.push(category);
          await saveCategories(categories);
        }
      } else {
        if (description) {
          if (description.length > 140) description = description.substring(0, 137) + "...";
          if (description.length > 0 && description.length < 70) description = description.padEnd(70);
        }
        if (params.tags) {
          tags = params.tags.split(",").map(t => t.trim().toLowerCase()).filter(t => t).slice(0, 8);
        }
        if (params.category) {
          category = params.category.toLowerCase();
        }
      }
      
      const entry: CatalogEntry = {
        filename,
        description,
        tags: tags.join(", "),
        category: category || "uncategorized",
        source: params.source || "manual",
        date_added: new Date().toISOString().split("T")[0],
        filepath,
        classified_at: new Date().toISOString(),
      };
      
      // Append-only write to JSONL
      await appendCatalogEntry(catalogPath, entry);
      const totalEntries = await countCatalogEntries(catalogPath);
      
      return {
        content: [{ type: "text", text: `Category: ${category}\nDescription: ${description}\nTags (8): ${entry.tags}` }],
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
      
      onUpdate?.({ content: [{ type: "text", text: `Classifying ${newImages.length} images with ${ctx.model.provider}/${ctx.model.id}...` }] });
      
      const results: CatalogEntry[] = [];
      let classified = 0;
      let failed = 0;
      
      for (const imagePath of newImages) {
        try {
          onUpdate?.({ content: [{ type: "text", text: `Classifying ${basename(imagePath)} (${classified + 1}/${newImages.length})...` }] });
          
          const result = await classifyWithVision(ctx.model, auth.apiKey, auth.headers || {}, imagePath, signal);
          
          // If new category was created, add to categories file
          const categories = await loadCategories();
          if (!categories.includes(result.category) && result.category !== "uncategorized") {
            categories.push(result.category);
            await saveCategories(categories);
          }
          
          const entry: CatalogEntry = {
            filename: basename(imagePath),
            description: result.description,
            tags: result.tags.join(", "),
            category: result.category,
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
          text: `Classified ${classified} images:${results.length > 0 ? "\n" + results.map(r => `- [${r.category}] ${r.filename}: "${r.description}"\n  Tags: ${r.tags}`).join("\n\n") : ""}${skipped > 0 ? `\n\nSkipped ${skipped} already-cataloged images` : ""}${failed > 0 ? `\n\nFailed: ${failed}` : ""}`
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
          text: `Found ${results.length} images:\n${results.map(r => `- [${r.category}] ${r.filename}\n  "${r.description}"\n  Tags: ${r.tags}`).join("\n\n")}`
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
          text: `Suggested for "${params.context}":\n${suggestions.map((r, i) => `${i + 1}. [${r.category}] ${r.filename}: ${r.description}`).join("\n")}`
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
      const categories = entries.reduce((acc, e) => { acc[e.category] = (acc[e.category] || 0) + 1; return acc; }, {} as Record<string, number>);
      
      return {
        content: [{
          type: "text",
          text: `Image Catalog:\n- Total: ${entries.length}\n- Format: JSONL (append-only)\n- Folder: ${DEFAULT_ASSET_FOLDER}\n- File: ${catalogPath}\n\nBy source:\n${Object.entries(sources).map(([src, count]) => `- ${src}: ${count}`).join("\n")}\n\nBy category:\n${Object.entries(categories).sort((a, b) => b[1] - a[1]).map(([cat, count]) => `- ${cat}: ${count}`).join("\n")}`
        }],
        details: { totalEntries: entries.length, sources, categories, catalogPath, format: "jsonl" },
      };
    },
  });
}
