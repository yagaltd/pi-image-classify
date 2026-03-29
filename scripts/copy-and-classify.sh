#!/bin/bash
# copy-and-classify.sh - Copy images from nanobanana-output to assets and classify
#
# Usage:
#   ./copy-and-classify.sh           # Copy and classify
#   ./copy-and-classify.sh --dry-run  # Show what would be done
#   ./copy-and-classify.sh --no-classify  # Copy only

set -euo pipefail

ASSETS_DIR="assets/images"
NANOBANANA_DIR="nanobanana-output"
CATALOG_FILE="assets/image_catalog.csv"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Parse args
DRY_RUN=false
NO_CLASSIFY=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --no-classify)
      NO_CLASSIFY=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [--dry-run] [--no-classify]"
      echo ""
      echo "Options:"
      echo "  --dry-run      Show what would be copied without copying"
      echo "  --no-classify  Copy images without classifying"
      exit 0
      ;;
    *)
      log_error "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Check directories
if [[ ! -d "$NANOBANANA_DIR" ]]; then
  log_error "nanobanana-output directory not found. Generate images first."
  exit 1
fi

mkdir -p "$ASSETS_DIR"

# Find new images
mapfile -t NEW_IMAGES < <(cd "$NANOBANANA_DIR" && find . -type f \( -iname "*.png" -o -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.gif" -o -iname "*.webp" \) 2>/dev/null | sed 's|^\./||' | while read -r img; do
  if [[ ! -f "$ASSETS_DIR/$img" ]]; then
    echo "$img"
  fi
done)

if [[ ${#NEW_IMAGES[@]} -eq 0 ]]; then
  log_info "No new images to copy from nanobanana-output."
  exit 0
fi

log_info "Found ${#NEW_IMAGES[@]} new images to copy"

if [[ $DRY_RUN == true ]]; then
  echo ""
  echo "Would copy ${#NEW_IMAGES[@]} images:"
  for img in "${NEW_IMAGES[@]}"; do
    echo "  - $img"
  done
  exit 0
fi

# Copy images
COPIED=0
for img in "${NEW_IMAGES[@]}"; do
  if cp "$NANOBANANA_DIR/$img" "$ASSETS_DIR/$img" 2>/dev/null; then
    ((COPIED++)) || true
    log_info "Copied: $img"
  else
    log_warn "Failed to copy: $img"
  fi
done

log_info "Copied $COPIED images to $ASSETS_DIR"

if [[ $NO_CLASSIFY == true ]]; then
  echo ""
  echo "Skipping classification. Run in pi:"
  echo "  Use classify_folder with folder=\"$ASSETS_DIR\""
  exit 0
fi

echo ""
log_info "Now classify in pi with:"
echo "  Use classify_folder with folder=\"$ASSETS_DIR\", source=\"nanobanana\""
