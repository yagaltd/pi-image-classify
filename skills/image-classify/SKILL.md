---
name: image-classify
description: Image classification and cataloging for pi. Understand, tag, and search image assets. Use when asked to "classify images", "catalog images", "search for images", "find an image", "suggest images for", or "organize image assets".
---

# Image Classify

Image classification and cataloging extension for pi-coding-agent. Generates descriptions and tags for images, stores in a searchable CSV catalog.

## Purpose

Enable:
- **Classification**: AI understands images and adds them to a catalog
- **Search**: Find images by text query or tags
- **Suggestions**: Get relevant image suggestions for content generation
- **Sync**: Import images from nanobanana-output

## Workflow

### 1. Set Up Asset Folder

Images are stored in `./assets/images/` by default. Create it:

```bash
mkdir -p assets/images
```

### 2. Add Images

**Manual**: Copy images to the folder
```bash
cp ~/Downloads/photo.jpg assets/images/
```

**From Nanobanana**: Sync generated images first:
```
Use sync_nanobanana tool, then classify_folder
```

### 3. Classify Images

**Single image:**
```
Use classify_image with file="assets/images/myphoto.jpg"
```

**Entire folder:**
```
Use classify_folder with folder="assets/images"
```

### 4. Search for Images

**By text query:**
```
Use search_images with query="sunset mountains"
```

**Get suggestions for content:**
```
Use suggest_images with context="blog post about hiking in mountains"
```

## Tools

| Tool | Use When |
|------|----------|
| `classify_image` | Classify single image, add to catalog |
| `classify_folder` | Batch classify all images in a folder |
| `search_images` | Search catalog by text query |
| `suggest_images` | Get relevant images for content generation |
| `sync_nanobanana` | Copy new images from nanobanana-output |
| `get_catalog_stats` | View catalog statistics |

## Output Location

- **Images**: `./assets/images/`
- **Catalog**: `./assets/image_catalog.csv`

## CSV Format

```csv
filename,description,tags,source,date_added,filepath
sunset.png,A vibrant sunset over snow-capped mountains...,"sunset,mountains,nature,landscape",nanobanana,2024-01-15,/path/to/sunset.png
```

## Example Interactions

### User wants to find an image
```
User: Find me a sunset image
→ Use search_images with query="sunset"
→ Returns matching images from catalog
```

### User generates content and wants relevant images
```
User: Write a blog post about mountain hiking
→ Use suggest_images with context="mountain hiking blog post"
→ Suggests relevant images from catalog
```

### User generates images with nanobanana and wants to catalog them
```
User: Generate a logo for my app
→ Nanobanana saves to ./nanobanana-output/
→ User: /sync-nanobanana
→ User: /classify
→ Images added to catalog
```

### User has new photos to catalog
```
User: I added new photos to assets/images
→ Use classify_folder with folder="assets/images"
→ All new images classified and added to catalog
```

## Best Practices

1. **Review before cataloging**: Images are added to catalog immediately
2. **Use descriptive filenames**: Helps with manual searching
3. **Classify in batches**: More efficient than single images
4. **Sync + Classify**: After generating with nanobanana, use both tools

## Requirements

- Google API key configured (for Gemini vision)
- Write access to `./assets/` directory
