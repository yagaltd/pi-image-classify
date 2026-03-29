# pi-image-classify

Image classification and cataloging for [pi-coding-agent](https://github.com/badlogic/pi-mono). Understand, tag, and search your image assets.

## What it does

- **Classify images** with AI-generated descriptions (70-140 chars) and tags
- **Catalog in CSV** for fast searching and retrieval
- **Search** by text query or tags
- **Suggest** relevant images for content generation
- **Sync** from nanobanana-output or other sources

## Install

```bash
pi install https://github.com/yagaltd/pi-image-classify
```

## Use It

### 1. Set up asset folder

```bash
mkdir -p assets/images
```

### 2. Add images

**From nanobanana:**
```
Use sync_nanobanana tool
```

**Manual:**
```bash
cp ~/Downloads/photo.jpg assets/images/
```

### 3. Classify

```
Use classify_folder with folder="assets/images"
```

### 4. Search & Suggest

**Find an image:**
```
Use search_images with query="sunset mountains"
```

**Get suggestions for content:**
```
Use suggest_images with context="blog post about hiking"
```

## Commands

| Command | What it does |
|---------|--------------|
| `/classify` | Classify all images in ./assets/images/ |

## Tools

| Tool | Use When |
|------|----------|
| `classify_image` | Classify single image |
| `classify_folder` | Batch classify folder |
| `search_images` | Search by text query |
| `suggest_images` | Get relevant suggestions |
| `sync_nanobanana` | Copy from nanobanana-output |
| `get_catalog_stats` | View catalog stats |
| `list_vision_models` | See available vision models |

## Output Locations

| Type | Path |
|------|------|
| Images | `./assets/images/` |
| Catalog | `./assets/image_catalog.csv` |

## CSV Format

```csv
filename,description,tags,source,date_added,filepath,model,provider
sunset.png,A vibrant sunset over snow-capped mountains...,"sunset,mountains,nature",nanobanana,2024-01-15,./assets/images/sunset.png,gemini-3.0-flash,google
```

## Workflow: Nanobanana → Classify → Use

```
1. pi: Use generate_image tool → saves to ./nanobanana-output/
2. User: Use sync_nanobanana tool → copies to ./assets/images/
3. User: Use classify_folder tool → adds to catalog
4. Later: Use suggest_images tool → finds relevant for new content
```

## Script Helper

Copy and classify in one step:

```bash
./scripts/copy-and-classify.sh        # Copy and show classify command
./scripts/copy-and-classify.sh --dry-run  # Preview what would be copied
./scripts/copy-and-classify.sh --no-classify  # Copy only
```

## Requirements

- Vision-capable model configured (Google Gemini, Claude, GPT-4o, etc.)
- Write access to `./assets/` directory

## License

MIT
