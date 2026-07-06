#!/usr/bin/env bash
# Copy swagger-ui-dist assets to a path nginx (www-data) can read.
# Pre-compresses with gzip when available (pairs with nginx gzip_static).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${ROOT}/node_modules/swagger-ui-dist"
DEST="${SWAGGER_UI_STATIC_DIR:-/var/lib/plug_server/swagger-ui-dist}"
DEST_PARENT="$(dirname "$DEST")"
SYNC_MODE="${SWAGGER_STATIC_SYNC:-auto}"

if [[ "$SYNC_MODE" == "skip" ]]; then
  echo "Skipping swagger static sync (SWAGGER_STATIC_SYNC=skip)"
  exit 0
fi

if [[ "$SYNC_MODE" == "auto" && ! -d "$DEST_PARENT" ]]; then
  echo "Skipping swagger static sync: ${DEST_PARENT} does not exist (dev/CI)"
  exit 0
fi

if [[ ! -d "$SRC" ]]; then
  echo "Missing ${SRC}; run npm install first." >&2
  exit 1
fi

ASSETS=(
  swagger-ui.css
  swagger-ui-bundle.js
  swagger-ui-standalone-preset.js
)

mkdir -p "$DEST"
for asset in "${ASSETS[@]}"; do
  install -m 0644 "${SRC}/${asset}" "${DEST}/${asset}"
  if command -v gzip >/dev/null 2>&1; then
    gzip -9 -kf "${DEST}/${asset}"
  fi
done

echo "Synced swagger-ui static assets to ${DEST}"
