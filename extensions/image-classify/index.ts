/**
 * pi-image-classify - Image classification and cataloging extension
 * 
 * Features:
 * - Classify images (describe + tag) and add to CSV catalog
 * - Search catalog by text query or tags
 * - Suggest relevant images for content generation
 * - Sync images from nanobanana-output to asset folder
 */

import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, basename, extname } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

const execAsync = promisify(exec);

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
  } catch {
    // Directory doesn't exist or is empty
  }
  
  return images;
}

function generateTagsFromDescription(description: string): string[] {
  // Simple keyword extraction - in production could use NLP
  const keywords = description.toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 3)
    .filter(w => !["this", "with", "from", "that", "have", "been", "were", "they", "their", "image", "photo", "picture"].includes(w));
  
  // Deduplicate and limit
  return [...new Set(keywords)].slice(0, 10);
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
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
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
  
  if (!existsSync(catalogPath)) {
    return entries;
  }
  
  const content = await readFile(catalogPath, "utf-8");
  const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("#") && !l.startsWith("filename"));
  
  for (const line of lines) {
    const parts = parseCSVLine(line);
    if (parts.length >= 5) {
      entries.push({
        filename: parts[0],
        description: parts[1],
        tags: parts[2],
        source: parts[3],
        dateAdded: parts[4],
        filepath: parts[5] || parts[0],
      });
    }
  }
  
  return entries;
}

async function saveCatalog(catalogPath: string, entries: CatalogEntry[]): Promise<void> {
  const header = "filename,description,tags,source,date_added,filepath";
  const lines = entries.map(e => [
    escapeCSV(e.filename),
    escapeCSV(e.description),
    escapeCSV(e.tags),
    escapeCSV(e.source),
    e.dateAdded,
    escapeCSV(e.filepath),
  ].join(","));
  
  await writeFile(catalogPath, [header, ...lines].join("\n") + "\n", "utf-8");
}

function entryExists(entries: CatalogEntry[], filepath: string): boolean {
  return entries.some(e => e.filepath === filepath || e.filename === basename(filepath));
}

function entryExistsByFilename(entries: CatalogEntry[], filename: string): boolean {
  return entries.some(e => e.filename === filename);
}

// ============================================================================
// Image Classification (using Gemini API)
// ============================================================================

async function classifyImageWithVision(
  apiKey: string,
  imagePath: string,
  signal?: AbortSignal
): Promise<{ description: string; tags: string[] }> {
  // Read image as base64
  const imageBuffer = await readFile(imagePath);
  const imageBase64 = imageBuffer.toString("base64");
  const mimeType = imagePath.endsWith(".png") ? "image/png" : "image/jpeg";
  
  const model = "gemini-2.0-flash"; // Vision model
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  
  const prompt = `Analyze this image and provide:
1. A SHORT description (70-140 characters) - capture the essence of what's in the image
2. Tags (comma-separated) - relevant keywords for searching later (max 10 tags, single words only)

Format your response as:
DESCRIPTION: [your 70-140 character description]
TAGS: [tag1, tag2, tag3, ...]

Be concise and specific. Focus on: subjects, setting, style, mood, colors, and key elements.`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inlineData: { mimeType, data: imageBase64 } }
        ]
      }],
      generationConfig: {
        maxOutputTokens: 256,
        temperature: 0.3,
      }
    }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error: ${error}`);
  }
  
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  
  // Parse response
  const descMatch = text.match(/DESCRIPTION:\s*(.+?)(?:\n|$)/i);
  const tagsMatch = text.match(/TAGS:\s*(.+?)(?:\n|$)/i);
  
  let description = descMatch?.[1]?.trim() || "Image description unavailable";
  let tagsStr = tagsMatch?.[1]?.trim() || "";
  
  // Ensure description is within bounds
  if (description.length > 140) {
    description = description.substring(0, 137) + "...";
  }
  if (description.length < 70) {
    description = description.padEnd(70);
  }
  
  // Parse tags
  let tags = tagsStr.split(",").map(t => t.trim().toLowerCase()).filter(t => t);
  if (tags.length === 0) {
    tags = generateTagsFromDescription(description);
  }
  tags = [...new Set(tags)].slice(0, 10);
  
  return { description, tags };
}

// ============================================================================
// Search Logic
// ============================================================================

function searchEntries(entries: CatalogEntry[], query: string, limit: number = 10): CatalogEntry[] {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/);
  
  const scored = entries.map(entry => {
    let score = 0;
    const descLower = entry.description.toLowerCase();
    const tagsLower = entry.tags.toLowerCase();
    const filenameLower = entry.filename.toLowerCase();
    
    // Exact filename match
    if (filenameLower.includes(queryLower)) score += 10;
    
    // Tag matches
    for (const word of queryWords) {
      if (tagsLower.includes(word)) score += 5;
      if (descLower.includes(word)) score += 2;
    }
    
    // Description word match
    const descWords = descLower.split(/\s+/);
    for (const word of queryWords) {
      if (descWords.some(w => w.startsWith(word) || word.startsWith(w))) score += 1;
    }
    
    return { entry, score };
  });
  
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.entry);
}

function suggestEntries(entries: CatalogEntry[], context: string, limit: number = 5): CatalogEntry[] {
  // For suggestions, be more permissive - match on any relevant keyword
  return searchEntries(entries, context, limit);
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
    description: "Classify a single image: generate description (70-140 chars) and tags, add to catalog CSV.",
    parameters: Type.Object({
      file: Type.String({ description: "Path to the image file to classify" }),
      description: Type.Optional(Type.String({ description: "Manual description override (70-140 chars)" })),
      tags: Type.Optional(Type.String({ description: "Manual comma-separated tags override" })),
      source: Type.Optional(Type.String({ description: "Source label (e.g., 'manual', 'nanobanana', 'downloaded')" })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const catalogPath = resolve(ctx.cwd, DEFAULT_CATALOG_FILE);
      const assetFolder = resolve(ctx.cwd, DEFAULT_ASSET_FOLDER);
      
      // Ensure directories exist
      await ensureDirectory(assetFolder);
      await ensureDirectory(resolve(ctx.cwd, "./assets"));
      
      const filepath = existsSync(params.file) 
        ? resolve(params.file) 
        : join(assetFolder, basename(params.file));
      
      if (!existsSync(filepath)) {
        throw new Error(`Image not found: ${filepath}`);
      }
      
      if (!isImageFile(filepath)) {
        throw new Error(`Not an image file: ${filepath}`);
      }
      
      onUpdate?.({ content: [{ type: "text", text: "Loading catalog..." }] });
      
      const entries = await loadCatalog(catalogPath);
      
      if (entryExists(entries, filepath)) {
        return {
          content: [{ type: "text", text: `Image already in catalog: ${basename(filepath)}` }],
          details: { alreadyExists: true, filepath },
        };
      }
      
      onUpdate?.({ content: [{ type: "text", text: "Analyzing image with AI..." }] });
      
      let description = params.description || "";
      let tags: string[] = [];
      
      if (!description && !params.tags) {
        // Use Gemini vision API
        const apiKey = await ctx.modelRegistry.getApiKeyForProvider("google");
        if (!apiKey) {
          throw new Error("No Google API key found. Configure Gemini API key.");
        }
        
        const result = await classifyImageWithVision(apiKey, filepath, signal);
        description = result.description;
        tags = result.tags;
      } else {
        if (description) {
          // Ensure bounds
          if (description.length > 140) description = description.substring(0, 137) + "...";
          if (description.length < 70) description = description.padEnd(70);
        }
        if (params.tags) {
          tags = params.tags.split(",").map(t => t.trim()).filter(t => t);
        }
      }
      
      // Add entry
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
        content: [{
          type: "text",
          text: `Classified and added to catalog:\n${description}\nTags: ${entry.tags}`
        }],
        details: { 
          catalogPath,
          entry,
          totalEntries: entries.length,
        },
      };
    },
  });

  // --------------------------------------------------------------------------
  // Tool: classify_folder
  // --------------------------------------------------------------------------
  pi.registerTool({
    name: "classify_folder",
    label: "Classify Folder",
    description: "Batch classify all images in a folder. Skips already-cataloged images.",
    parameters: Type.Object({
      folder: Type.Optional(Type.String({ description: "Folder path (default: ./assets/images)" })),
      source: Type.Optional(Type.String({ description: "Source label for all images" })),
      limit: Type.Optional(Type.Number({ description: "Max images to classify (default: unlimited)" })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const folderPath = resolve(ctx.cwd, params.folder || DEFAULT_ASSET_FOLDER);
      const catalogPath = resolve(ctx.cwd, DEFAULT_CATALOG_FILE);
      
      if (!existsSync(folderPath)) {
        await ensureDirectory(folderPath);
        return {
          content: [{ type: "text", text: `Created empty folder: ${folderPath}. Add images and run again.` }],
          details: { folderPath, created: true },
        };
      }
      
      onUpdate?.({ content: [{ type: "text", text: "Scanning folder..." }] });
      
      const images = await listImages(folderPath);
      
      if (images.length === 0) {
        return {
          content: [{ type: "text", text: `No images found in ${folderPath}` }],
          details: { folderPath, imagesFound: 0 },
        };
      }
      
      const entries = await loadCatalog(catalogPath);
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider("google");
      
      if (!apiKey) {
        throw new Error("No Google API key found. Configure Gemini API key.");
      }
      
      const newImages = images
        .filter(img => !entryExists(entries, img))
        .slice(0, params.limit || undefined);
      
      const skipped = images.length - newImages.length;
      
      if (newImages.length === 0) {
        return {
          content: [{ type: "text", text: `All ${images.length} images already cataloged.` }],
          details: { imagesFound: images.length, skipped, totalEntries: entries.length },
        };
      }
      
      onUpdate?.({ content: [{ type: "text", text: `Classifying ${newImages.length} new images...` }] });
      
      const results: CatalogEntry[] = [];
      let classified = 0;
      
      for (const imagePath of newImages) {
        try {
          onUpdate?.({ 
            content: [{ type: "text", text: `Classifying ${basename(imagePath)} (${classified + 1}/${newImages.length})...` }],
            details: { progress: Math.round((classified / newImages.length) * 100) },
          });
          
          const result = await classifyImageWithVision(apiKey, imagePath, signal);
          
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
          // Continue with other images
          console.error(`Failed to classify ${imagePath}:`, error);
        }
      }
      
      await saveCatalog(catalogPath, entries);
      
      return {
        content: [{
          type: "text",
          text: `Classified ${classified} images:\n${results.map(r => `- ${r.filename}: ${r.description}`).join("\n")}${skipped > 0 ? `\n\nSkipped ${skipped} already-cataloged images` : ""}`
        }],
        details: { 
          catalogPath,
          classified,
          skipped,
          results,
          totalEntries: entries.length,
        },
      };
    },
  });

  // --------------------------------------------------------------------------
  // Tool: search_images
  // --------------------------------------------------------------------------
  pi.registerTool({
    name: "search_images",
    label: "Search Images",
    description: "Search catalog for images matching a text query. Returns filenames, descriptions, and tags.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query (matches description, tags, filename)" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const catalogPath = resolve(ctx.cwd, DEFAULT_CATALOG_FILE);
      
      const entries = await loadCatalog(catalogPath);
      
      if (entries.length === 0) {
        return {
          content: [{ type: "text", text: "No images in catalog. Run /classify first." }],
          details: { totalEntries: 0 },
        };
      }
      
      const results = searchEntries(entries, params.query, params.limit || 10);
      
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No images found matching: "${params.query}"` }],
          details: { query: params.query, totalEntries: entries.length, matches: 0 },
        };
      }
      
      return {
        content: [{
          type: "text",
          text: `Found ${results.length} images:\n${results.map(r => 
            `- ${r.filename}\n  "${r.description}"\n  Tags: ${r.tags}\n  Path: ${r.filepath}`
          ).join("\n\n")}`
        }],
        details: { 
          query: params.query,
          matches: results.length,
          totalEntries: entries.length,
          results,
        },
      };
    },
  });

  // --------------------------------------------------------------------------
  // Tool: suggest_images
  // --------------------------------------------------------------------------
  pi.registerTool({
    name: "suggest_images",
    label: "Suggest Images",
    description: "Given a context/prompt, suggest relevant images from catalog for content generation.",
    parameters: Type.Object({
      context: Type.String({ description: "Context or content description to match against" }),
      limit: Type.Optional(Type.Number({ description: "Max suggestions (default: 5)" })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const catalogPath = resolve(ctx.cwd, DEFAULT_CATALOG_FILE);
      
      const entries = await loadCatalog(catalogPath);
      
      if (entries.length === 0) {
        return {
          content: [{ type: "text", text: "No images in catalog. Run /classify first." }],
          details: { totalEntries: 0 },
        };
      }
      
      const suggestions = suggestEntries(entries, params.context, params.limit || 5);
      
      if (suggestions.length === 0) {
        return {
          content: [{ type: "text", text: `No relevant images found for: "${params.context}"` }],
          details: { context: params.context, totalEntries: entries.length },
        };
      }
      
      return {
        content: [{
          type: "text",
          text: `Suggested images for "${params.context}":\n${suggestions.map((r, i) => 
            `${i + 1}. **${r.filename}**\n   "${r.description}"\n   ${r.tags}`
          ).join("\n\n")}`
        }],
        details: { 
          context: params.context,
          suggestions,
          totalEntries: entries.length,
        },
      };
    },
  });

  // --------------------------------------------------------------------------
  // Tool: sync_nanobanana
  // --------------------------------------------------------------------------
  pi.registerTool({
    name: "sync_nanobanana",
    label: "Sync Nanobanana",
    description: "Copy new images from nanobanana-output to asset folder. Does not classify - run /classify afterwards.",
    parameters: Type.Object({
      dryRun: Type.Optional(Type.Boolean({ description: "Show what would be copied without copying" })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const nanobananaPath = resolve(ctx.cwd, NANOBANANA_OUTPUT);
      const assetFolder = resolve(ctx.cwd, DEFAULT_ASSET_FOLDER);
      
      if (!existsSync(nanobananaPath)) {
        return {
          content: [{ type: "text", text: `nanobanana-output folder not found. Generate images first.` }],
          details: { nanobananaPath },
        };
      }
      
      await ensureDirectory(assetFolder);
      
      const nanobananaImages = await listImages(nanobananaPath);
      const assetImages = await listImages(assetFolder);
      
      // Find images not yet in assets
      const existingFilenames = new Set(assetImages.map(p => basename(p)));
      const newImages = nanobananaImages.filter(p => !existingFilenames.has(basename(p)));
      
      if (newImages.length === 0) {
        return {
          content: [{ type: "text", text: `No new images to copy from nanobanana-output.` }],
          details: { nanobananaCount: nanobananaImages.length, assetCount: assetImages.length },
        };
      }
      
      if (params.dryRun) {
        return {
          content: [{
            type: "text",
            text: `Would copy ${newImages.length} images:\n${newImages.map(p => `- ${basename(p)}`).join("\n")}`
          }],
          details: { dryRun: true, newImages: newImages.map(basename) },
        };
      }
      
      onUpdate?.({ content: [{ type: "text", text: `Copying ${newImages.length} images...` }] });
      
      const copied: string[] = [];
      for (const src of newImages) {
        const dest = join(assetFolder, basename(src));
        const content = await readFile(src);
        await writeFile(dest, content);
        copied.push(basename(src));
      }
      
      return {
        content: [{
          type: "text",
          text: `Copied ${copied.length} images to ${assetFolder}:\n${copied.map(f => `- ${f}`).join("\n")}\n\nRun /classify to add them to the catalog.`
        }],
        details: { 
          copied,
          assetFolder,
          totalAssetImages: assetImages.length + copied.length,
        },
      };
    },
  });

  // --------------------------------------------------------------------------
  // Tool: get_catalog_stats
  // --------------------------------------------------------------------------
  pi.registerTool({
    name: "get_catalog_stats",
    label: "Catalog Stats",
    description: "Get statistics about the image catalog.",
    parameters: Type.Object({}),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const catalogPath = resolve(ctx.cwd, DEFAULT_CATALOG_FILE);
      const entries = await loadCatalog(catalogPath);
      
      const sources = entries.reduce((acc, e) => {
        acc[e.source] = (acc[e.source] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      return {
        content: [{
          type: "text",
          text: `Image Catalog Stats:\n- Total images: ${entries.length}\n- Asset folder: ${DEFAULT_ASSET_FOLDER}\n- Catalog file: ${catalogPath}\n\nBy source:\n${Object.entries(sources).map(([src, count]) => `- ${src}: ${count}`).join("\n")}`
        }],
        details: { totalEntries: entries.length, sources, catalogPath },
      };
    },
  });

  // --------------------------------------------------------------------------
  // Commands
  // --------------------------------------------------------------------------
  
  pi.registerCommand("classify", {
    description: "Classify images in ./assets/images/ and add to catalog",
    handler: async (args, ctx) => {
      const folder = args?.trim() || DEFAULT_ASSET_FOLDER;
      ctx.ui.notify(`Classifying images in ${folder}...`, "info");
    },
  });

  pi.registerCommand("images", {
    description: "Image catalog commands: search, sync, stats",
    handler: async (args, ctx) => {
      ctx.ui.notify("Use: /images search <query>, /images sync, or /classify", "info");
    },
  });
}
