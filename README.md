# pi-image-classify

Image classification and cataloging for [pi-coding-agent](https://github.com/badlogic/pi-mono). Understand, tag, and search your image assets.

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

```
Use classify_folder with folder="assets/images"
```

## Tools

| Tool | Use |
|------|-----|
| `classify_image` | Classify single image |
| `classify_folder` | Batch classify folder |
| `search_images` | Search by text |
| `suggest_images` | Get suggestions |
| `sync_nanobanana` | Copy from nanobanana |
| `get_catalog_stats` | View stats |

## Command

```
/classify  → Triggers classify_folder
```

## Output

- Images: `./assets/images/`
- Catalog: `./assets/image_catalog.csv`

## Model

Uses the currently selected model. If you get an error about vision support, use `/model` to select a vision-capable model (Gemini, Claude, GPT-4o, etc.).

## License

MIT
