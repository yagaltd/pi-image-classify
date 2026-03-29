# pi-image-classify

Image classification and cataloging for [pi-coding-agent](https://github.com/badlogic/pi-mono). Understand, tag, and search your image assets.

## Features

- ✅ **Rich Descriptions** (300-500 characters) - Detailed, accurate image descriptions
- ✅ **User Context Injection** - Provide domain-specific guidance for better accuracy
- ✅ **Guidelines Files** - Reference brand/style guides without code changes
- ✅ **Simple Search** - Description-only search with relevance scoring
- ✅ **Incremental Processing** - Skip already-cataloged images
- ✅ **Append-Only Catalog** - Efficient JSONL format

## Install

```bash
pi install https://github.com/yagaltd/pi-image-classify
```

## Use It

### 1. Select a vision model

```
/model
```

### 2. Set up folder

```bash
mkdir -p assets/images
```

### 3. Add & classify

#### Basic Classification
```
Use classify_image with file="assets/images/myphoto.jpg"
```

#### With User Context (Better Accuracy)
```
Use classify_image with file="assets/images/myphoto.jpg", context="this is about technical documents, use clinical terminology"
```

#### With Guidelines File (Brand/Style Guidance)
```
Use classify_image with file="assets/images/calibration-cert.png", guidelinesFile="assets/technical-guidelines.md"
```

#### Combined (Context + Guidelines)
```
Use classify_image with file="assets/images/cat.jpg", context="this is about cats and dogs, pet animals", guidelinesFile="assets/pet-guidelines.md"
```

### 4. Batch classify folder

```
Use classify_folder with folder="assets/images"
```

Batch classification also supports context and guidelines:
```
Use classify_folder with folder="assets/images/docs", context="technical calibration documents", guidelinesFile="assets/technical-guidelines.md"
```

## Search

### Search Catalog
```
Use search_images with query="blueprint"
```

### Get Suggestions
```
Use suggest_images with context="blog post about hiking"
```

## Tools

| Tool | Parameters | Use |
|------|-------------|-----|
| `classify_image` | `file`, `description`, `context`, `guidelinesFile`, `source` | Classify single image with optional context/guidelines |
| `classify_folder` | `folder`, `source`, `context`, `guidelinesFile`, `limit` | Batch classify folder |
| `search_images` | `query`, `limit` | Search catalog by text query |
| `suggest_images` | `context`, `limit` | Get suggestions based on context |
| `sync_nanobanana` | `dryRun` | Copy from nanobanana-output |
| `get_catalog_stats` | - | View catalog statistics |

## Command

```
/classify  → Triggers classify_folder
```

## Output

- Images: `./assets/images/`
- Catalog: `./assets/image_catalog.jsonl` (JSONL append-only for efficient incremental updates)

## Creating Guidelines Files

### Example: Technical Documents

Create `assets/technical-guidelines.md`:

```markdown
# Technical Document Classification Guidelines

## General Guidelines

When analyzing technical documents, calibration certificates, or engineering drawings:

1. **READ ALL TEXT** - Carefully read and transcribe all visible text content
2. **ACCURACY FIRST** - Don't guess or hallucinate - describe only what's clearly visible
3. **TECHNICAL TERMS** - Use appropriate technical terminology
4. **DOCUMENT STRUCTURE** - Describe layout, sections, tables, grids
5. **SPECIFIC DETAILS** - Include serial numbers, model details, measurements when visible
6. **CALIBRATION DATA** - For certificates, include calibration data and results

### What to Look For

- Document headers and titles
- Tables, grids, and structured data
- Serial numbers and model identifiers
- Test points and measurements
- Calibration data and results
- Signatures and approval sections
- Technical specifications and tolerances

### What to Avoid

- Don't guess document content if text is illegible
- Don't assume specific equipment types if not clearly shown
- Don't fabricate details not visible in the image
```

### Example: Cat Domain Knowledge

Create `assets/pet-guidelines.md`:

```markdown
# Pet/Cat Image Classification Guidelines

## Key Attributes to Describe

- Coat color and pattern (ginger, calico, tabby, white, black, orange, cream)
- Eye color (green, blue, amber, heterochromia, gold, copper)
- Pose and expression (sitting, standing, playing, sleeping, alert, curious, relaxed)
- Fur texture (fluffy, short, smooth, soft, glossy, wiry)
- Age indicators (kitten, adult, senior)
- Setting (indoor, outdoor, garden, sunny window, etc.)

## Common Cat Colors

- **Orange/Ginger**: Warm reddish-orange tones
- **Calico**: Patches of multiple colors
- **Tabby**: Striped pattern (classic tabby, mackerel)
- **Tuxedo**: Black and white
- **Pointed**: Dark tips on ears, face, or tail
- **Siamese**: Light body with dark points

## What to Prioritize

1. **Breed characteristics** - Coat pattern, ear shape, face structure
2. **Eye details** - Color, shape, expression
3. **Mood/personality** - Alert, curious, relaxed, playful
4. **Quality indicators** - Fur health, grooming condition
```

## How to Use

### Method 1: Use Context Parameter

Provide domain knowledge inline:
```
Classify images in folder="assets/images/photos", context="these are wedding photographs, use romantic and celebratory language"
```

### Method 2: Use Guidelines File

Reference a reusable style guide:
```
Classify images in folder="assets/images/brand-logos", guidelinesFile="assets/brand-guidelines.md"
```

### Method 3: Combined

Use both context and guidelines:
```
Classify images in folder="assets/images/tech-docs", context="industrial technical drawings", guidelinesFile="assets/technical-guidelines.md"
```

## Model

Uses the currently selected model. If you get an error about vision support, use `/model` to select a vision-capable model (Gemini, Claude, GPT-4o, etc.).

## Catalog Format

Each catalog entry contains:
- `filename`: Image filename
- `description`: Rich description (300-500 characters)
- `source`: Classification source (manual, batch, nanobanana, etc.)
- `date_added`: Classification date
- `filepath`: Full path to image file
- `classified_at`: Timestamp

**Note:** Tags and categories have been removed - descriptions provide all searchable metadata. Simple grep-based search on descriptions works well for small-medium catalogs.

## License

MIT
