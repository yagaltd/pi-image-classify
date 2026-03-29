---
name: image-classify
description: Image classification and cataloging for pi. Understand, tag, and search image assets. Use when asked to "classify images", "catalog images", "search for images", "find an image", or "organize image assets".
---

# Image Classify

Classify images with AI and store in a searchable CSV catalog.

## Setup

```bash
mkdir -p assets/images
```

## Classify Images

**Single image:**
```
Use classify_image with file="assets/images/myphoto.jpg"
```

**Entire folder:**
```
Use classify_folder with folder="assets/images"
```

**From nanobanana:**
```
Use sync_nanobanana tool first, then classify_folder
```

## Search

**Find images:**
```
Use search_images with query="sunset mountains"
```

**Suggest for content:**
```
Use suggest_images with context="blog post about hiking"
```

## Model

Uses the currently selected model in pi. Make sure it's a vision-capable model:
- `/model` to select a model

If the model doesn't support vision, you'll get an error. Select a different model and try again.

## Tools

| Tool | Use |
|------|-----|
| `classify_image` | Classify single image |
| `classify_folder` | Batch classify folder |
| `search_images` | Search by text |
| `suggest_images` | Get suggestions |
| `sync_nanobanana` | Copy from nanobanana-output |
| `get_catalog_stats` | View stats |

## Output

- Images: `./assets/images/`
- Catalog: `./assets/image_catalog.csv`
