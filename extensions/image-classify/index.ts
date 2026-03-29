/**
 * pi-image-classify - Image classification and cataloging extension
 * 
 * Features:
 * - Classify images (describe + tag) and add to CSV catalog
 * - Search catalog by text query or tags
 * - Suggest relevant images for content generation
 * - Sync images from nanobanana-output to asset folder
 * 
 * Uses the currently active model for vision (if supported) or falls back to Google Gemini.
 */

import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, basename, extname } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

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
  const keywords = description.toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 3)
    .filter(w => !["this", "with", "from", "that", "have", "been", "were", "they", "their", "image", "photo", "picture"].includes(w));
  
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
// Vision Model Interface
// ============================================================================

interface VisionResult {
  description: string;
  tags: string[];
}

async function classifyWithModel(
  model: Model<any>,
  apiKey: string,
  imagePath: string,
  signal?: AbortSignal
): Promise<VisionResult> {
  // Read image as base64
  const imageBuffer = await readFile(imagePath);
  const imageBase64 = imageBuffer.toString("base64");
  const mimeType = imagePath.endsWith(".png") ? "image/png" : "image/jpeg";

  const prompt = `Analyze this image and provide:
1. A SHORT description (70-140 characters) - capture the essence of what's in the image
2. Tags (comma-separated) - relevant keywords for searching later (max 10 tags, single words only)

Format your response as:
DESCRIPTION: [your 70-140 character description]
TAGS: [tag1, tag2, tag3, ...]

Be concise and specific. Focus on: subjects, setting, style, mood, colors, and key elements.`;

  // Route to appropriate API based on provider
  switch (model.provider) {
    case "google":
    case "google-gemini-cli":
    case "google-vertex":
    case "google-antigravity":
      return classifyWithGoogle(model, apiKey, imageBase64, mimeType, prompt, signal);
    
    case "anthropic":
      return classifyWithAnthropic(model, apiKey, imageBase64, mimeType, prompt, signal);
    
    case "openai":
      return classifyWithOpenAI(model, apiKey, imageBase64, mimeType, prompt, signal);
    
    default:
      // Try Google as fallback
      return classifyWithGoogleFallback(apiKey, model.id, imageBase64, mimeType, prompt, signal);
  }
}

async function classifyWithGoogle(
  model: Model<any>,
  apiKey: string,
  imageBase64: string,
  mimeType: string,
  prompt: string,
  signal?: AbortSignal
): Promise<VisionResult> {
  const baseUrl = model.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
  const url = `${baseUrl}/models/${model.id}:generateContent?key=${apiKey}`;

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
    throw new Error(`Google API error: ${error}`);
  }

  const data = await response.json();
  return parseVisionResponse(data);
}

async function classifyWithGoogleFallback(
  apiKey: string,
  modelId: string,
  imageBase64: string,
  mimeType: string,
  prompt: string,
  signal?: AbortSignal
): Promise<VisionResult> {
  // Try Gemini 2.0 Flash as fallback
  const model = modelId.includes("gemini-2") ? modelId : "gemini-2.0-flash";
  return classifyWithGoogle(
    { provider: "google", id: model, baseUrl: "https://generativelanguage.googleapis.com/v1beta" } as Model<any>,
    apiKey,
    imageBase64,
    mimeType,
    prompt,
    signal
  );
}

async function classifyWithAnthropic(
  model: Model<any>,
  apiKey: string,
  imageBase64: string,
  mimeType: string,
  prompt: string,
  signal?: AbortSignal
): Promise<VisionResult> {
  const url = `${model.baseUrl || "https://api.anthropic.com"}/v1/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    signal,
    body: JSON.stringify({
      model: model.id,
      max_tokens: 256,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType as any, data: imageBase64 } },
          { type: "text", text: prompt }
        ]
      }]
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic API error: ${error}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || "";
  return parseVisionResponseText(text);
}

async function classifyWithOpenAI(
  model: Model<any>,
  apiKey: string,
  imageBase64: string,
  mimeType: string,
  prompt: string,
  signal?: AbortSignal
): Promise<VisionResult> {
  const url = `${model.baseUrl || "https://api.openai.com/v1"}/chat/completions`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    signal,
    body: JSON.stringify({
      model: model.id,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          { type: "text", text: prompt }
        ]
      }],
      max_tokens: 256,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${error}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "";
  return parseVisionResponseText(text);
}

function parseVisionResponse(data: any): VisionResult {
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return parseVisionResponseText(text);
}

function parseVisionResponseText(text: string): VisionResult {
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
  
  let tags = tagsStr.split(",").map((t: string) => t.trim().toLowerCase()).filter((t: string) => t);
  if (tags.length === 0) {
    tags = generateTagsFromDescription(description);
  }
  tags = [...new Set(tags)].slice(0, 10);
  
  return { description, tags };
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
  model?: string;
  provider?: string;
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
        model: parts[6],
        provider: parts[7],
      });
    }
  }
  
  return entries;
}

async function saveCatalog(catalogPath: string, entries: CatalogEntry[]): Promise<void> {
  const header = "filename,description,tags,source,date_added,filepath,model,provider";
  const lines = entries.map(e => [
    escapeCSV(e.filename),
    escapeCSV(e.description),
    escapeCSV(e.tags),
    escapeCSV(e.source),
    e.dateAdded,
    escapeCSV(e.filepath),
    e.model || "",
    e.provider || "",
  ].join(","));
  
  await writeFile(catalogPath, [header, ...lines].join("\n") + "\n", "utf-8");
}

function entryExists(entries: CatalogEntry[], filepath: string): boolean {
  return entries.some(e => e.filepath === filepath || e.filename === basename(filepath));
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
    
    if (filenameLower.includes(queryLower)) score += 10;
    
    for (const word of queryWords) {
      if (tagsLower.includes(word)) score += 5;
      if (descLower.includes(word)) score += 2;
    }
    
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
  return searchEntries(entries, context, limit);
}

// ============================================================================
// Available Vision Models
// ============================================================================

function getVisionModels(registry: any): Array<{ model: Model<any>; label: string }> {
  const available = registry.getAvailable ? registry.getAvailable() : registry.getAll ? registry.getAll() : [];
  return available
    .filter((m: Model<any>) => m.input && m.input.includes("image"))
    .map((m: Model<any>) => ({
      model: m,
      label: `${m.provider}/${m.id} ${m.name ? `(${m.name})` : ""}`
    }));
}

interface VisionModelResult {
  model: Model<any>;
  apiKey: string;
  usedFallback: boolean;
}

/**
 * Get the best vision model to use.
 * Priority:
 * 1. Explicitly specified model
 * 2. Current model (trust it supports vision)
 * 3. Any available vision model
 * 4. Google Gemini as fallback
 */
async function getVisionModel(
  ctx: any,
  explicitProvider?: string,
  explicitModelId?: string
): Promise<VisionModelResult> {
  // 1. Explicit model requested
  if (explicitModelId) {
    const provider = explicitProvider || ctx.model?.provider || "google";
    const model = ctx.modelRegistry.find(provider, explicitModelId);
    if (!model) {
      throw new Error(`Model not found: ${provider}/${explicitModelId}. Check your settings.`);
    }
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
    if (!apiKey) {
      throw new Error(`No API key configured for ${provider}. Set GEMINI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY in your auth.json.`);
    }
    return { model, apiKey, usedFallback: false };
  }

  // 2. Try current model first (trust it supports vision)
  if (ctx.model) {
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(ctx.model.provider);
    if (apiKey) {
      return { model: ctx.model, apiKey, usedFallback: false };
    }
  }

  // 3. Try any available vision model
  const visionModels = getVisionModels(ctx.modelRegistry);
  if (visionModels.length > 0) {
    const vm = visionModels[0];
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(vm.model.provider);
    if (apiKey) {
      return { model: vm.model, apiKey, usedFallback: false };
    }
  }

  // 4. Fallback to Google Gemini
  const googleModel = ctx.modelRegistry.find("google", "gemini-2.0-flash")
    || ctx.modelRegistry.find("google", "gemini-1.5-flash")
    || ctx.modelRegistry.find("google", "gemini-2.0-flash-preview");
  
  if (googleModel) {
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider("google");
    if (apiKey) {
      return { model: googleModel, apiKey, usedFallback: true };
    }
  }

  throw new Error(
    "No vision model available. Options:\n" +
    "1. Select a vision-capable model with /model\n" +
    "2. Configure a vision model (Gemini, Claude, GPT-4o) in settings\n" +
    "3. Set GEMINI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY"
  );
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
    description: "Classify a single image: generate description (70-140 chars) and tags, add to catalog CSV. Uses current vision model or specified model.",
    parameters: Type.Object({
      file: Type.String({ description: "Path to the image file to classify" }),
      description: Type.Optional(Type.String({ description: "Manual description override (70-140 chars)" })),
      tags: Type.Optional(Type.String({ description: "Manual comma-separated tags override" })),
      source: Type.Optional(Type.String({ description: "Source label (e.g., 'manual', 'nanobanana', 'downloaded')" })),
      provider: Type.Optional(StringEnum(["google", "anthropic", "openai", "current"] as const)),
      modelId: Type.Optional(Type.String({ description: "Specific model ID to use (e.g., 'gemini-2.0-flash', 'claude-3-5-sonnet-20241022')" })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const catalogPath = resolve(ctx.cwd, DEFAULT_CATALOG_FILE);
      const assetFolder = resolve(ctx.cwd, DEFAULT_ASSET_FOLDER);
      
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
      
      // Determine which model to use
      // Get vision model (tries current model first, then falls back to Gemini)
      const visionResult = await getVisionModel(ctx, params.provider, params.modelId);
      
      onUpdate?.({ 
        content: [{ 
          type: "text", 
          text: visionResult.usedFallback 
            ? `Current model may not support vision. Trying ${visionResult.model.provider}/${visionResult.model.id}...`
            : `Analyzing with ${visionResult.model.provider}/${visionResult.model.id}...`
        }] 
      });
      
      let description = params.description || "";
      let tags: string[] = [];
      
      if (!description && !params.tags) {
        const result = await classifyWithModel(visionResult.model, visionResult.apiKey, filepath, signal);
        description = result.description;
        tags = result.tags;
      } else {
        if (description) {
          if (description.length > 140) description = description.substring(0, 137) + "...";
          if (description.length < 70) description = description.padEnd(70);
        }
        if (params.tags) {
          tags = params.tags.split(",").map(t => t.trim()).filter(t => t);
        }
      }
      
      const entry: CatalogEntry = {
        filename: basename(filepath),
        description,
        tags: tags.join(", "),
        source: params.source || "manual",
        dateAdded: new Date().toISOString().split("T")[0],
        filepath,
        model: visionResult.model.id,
        provider: visionResult.model.provider,
      };
      
      entries.push(entry);
      await saveCatalog(catalogPath, entries);
      
      return {
        content: [{
          type: "text",
          text: `Classified with ${visionResult.model.provider}/${visionResult.model.id}:\n${description}\nTags: ${entry.tags}`
        }],
        details: { 
          catalogPath,
          entry,
          model: visionResult.model.id,
          provider: visionResult.model.provider,
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
    description: "Batch classify all images in a folder. Skips already-cataloged images. Uses current vision model.",
    parameters: Type.Object({
      folder: Type.Optional(Type.String({ description: "Folder path (default: ./assets/images)" })),
      source: Type.Optional(Type.String({ description: "Source label for all images" })),
      provider: Type.Optional(StringEnum(["google", "anthropic", "openai", "current"] as const)),
      modelId: Type.Optional(Type.String({ description: "Specific model ID" })),
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
      
      // Get vision model (tries current model first, then falls back to Gemini)
      const visionResult = await getVisionModel(ctx, params.provider, params.modelId);
      
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
      
      onUpdate?.({ content: [{ 
        type: "text", 
        text: visionResult.usedFallback 
          ? `Classifying ${newImages.length} images with ${visionResult.model.provider}/${visionResult.model.id}...` 
          : `Classifying ${newImages.length} images with ${visionResult.model.provider}/${visionResult.model.id}...`
      }] });
      
      const results: CatalogEntry[] = [];
      let classified = 0;
      
      for (const imagePath of newImages) {
        try {
          onUpdate?.({ 
            content: [{ type: "text", text: `Classifying ${basename(imagePath)} (${classified + 1}/${newImages.length})...` }],
            details: { progress: Math.round((classified / newImages.length) * 100) },
          });
          
          const result = await classifyWithModel(visionResult.model, visionResult.apiKey, imagePath, signal);
          
          const entry: CatalogEntry = {
            filename: basename(imagePath),
            description: result.description,
            tags: result.tags.join(", "),
            source: params.source || "batch",
            dateAdded: new Date().toISOString().split("T")[0],
            filepath: imagePath,
            model: visionResult.model.id,
            provider: visionResult.model.provider,
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
          text: `Classified ${classified} images with ${visionResult.model.provider}/${visionResult.model.id}:\n${results.map(r => `- ${r.filename}: ${r.description}`).join("\n")}${skipped > 0 ? `\n\nSkipped ${skipped} already-cataloged images` : ""}`
        }],
        details: { 
          catalogPath,
          classified,
          skipped,
          results,
          model: visionResult.model.id,
          provider: visionResult.model.provider,
          totalEntries: entries.length,
        },
      };
    },
  });

  // --------------------------------------------------------------------------
  // Tool: list_vision_models
  // --------------------------------------------------------------------------
  pi.registerTool({
    name: "list_vision_models",
    label: "List Vision Models",
    description: "List all configured models that support image vision.",
    parameters: Type.Object({}),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const visionModels = getVisionModels(ctx.modelRegistry);
      const current = ctx.model;
      const currentSupportsVision = current && current.input && current.input.includes("image");
      
      const lines = [
        `Configured vision models (${visionModels.length}):`,
        "",
        ...visionModels.map((vm, i) => {
          const isCurrent = current && vm.model.id === current.id && vm.model.provider === current.provider;
          return `${isCurrent ? "★" : " "} ${vm.label}${isCurrent ? " (current)" : ""}`;
        }),
        "",
        currentSupportsVision 
          ? `Current model: ${current?.provider}/${current?.id} ✓ supports vision`
          : `Current model: ${current?.provider}/${current?.id} ✗ no vision`,
      ];
      
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { 
          visionModels: visionModels.map(vm => ({ provider: vm.model.provider, id: vm.model.id })),
          currentModel: current ? { provider: current.provider, id: current.id } : null,
          currentSupportsVision,
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
            `- ${r.filename}\n  "${r.description}"\n  Tags: ${r.tags}\n  Path: ${r.filepath}${r.model ? `\n  Model: ${r.provider}/${r.model}` : ""}`
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
      
      const models = entries.reduce((acc, e) => {
        const key = e.model ? `${e.provider}/${e.model}` : "unknown";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      return {
        content: [{
          type: "text",
          text: `Image Catalog Stats:\n- Total images: ${entries.length}\n- Asset folder: ${DEFAULT_ASSET_FOLDER}\n- Catalog file: ${catalogPath}\n\nBy source:\n${Object.entries(sources).map(([src, count]) => `- ${src}: ${count}`).join("\n")}\n\nBy model:\n${Object.entries(models).map(([model, count]) => `- ${model}: ${count}`).join("\n")}`
        }],
        details: { totalEntries: entries.length, sources, models, catalogPath },
      };
    },
  });

  // --------------------------------------------------------------------------
  // Commands
  // --------------------------------------------------------------------------
  
  pi.registerCommand("classify", {
    description: "Classify all images in ./assets/images/ and add to catalog CSV",
    handler: async (args, ctx) => {
      const current = ctx.model;
      const supportsVision = current && current.input && current.input.includes("image");
      const modelInfo = supportsVision 
        ? `${current?.provider}/${current?.id}` 
        : "(no vision model selected)";
      
      ctx.ui.notify(`Classifying with ${modelInfo}...`, "info");
      
      // Inject a user message to trigger the classify_folder tool
      ctx.sessionManager.appendMessage({
        role: "user",
        content: [{
          type: "text",
          text: `Use classify_folder with folder="./assets/images"`
        }],
        timestamp: Date.now(),
      });
    },
  });
}
