#!/usr/bin/env bash
# Install dsh-mcp-manager into the web profile:
#   1. copy the package into <profile>/node_modules/dsh-mcp-manager/
#   2. append the loader mount line to <profile>/cordis.patch.yml (idempotent)
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${DSH_MCP_PROFILE:-$HOME/.dsh/profiles/web}"
DEST="$PROFILE/node_modules/dsh-mcp-manager"
PATCH="$PROFILE/cordis.patch.yml"

if [ ! -f "$SRC/package.json" ] || [ ! -f "$SRC/lib/index.js" ] || [ ! -f "$SRC/lib/client.js" ]; then
  echo "error: build artifacts missing in $SRC (run: node build-client.mjs)" >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
rm -rf "$DEST/node_modules" "$DEST/test-host.mjs" "$DEST/dynamic-host.js" \
       "$DEST/dynamic-host-body.js" "$DEST/dynamic-client.js" "$DEST/build-client.mjs" "$DEST/src"
echo "installed -> $DEST"

if ! grep -q "id: mcp-manager" "$PATCH" 2>/dev/null; then
  printf -- '- insert:\n    - id: mcp-manager\n      name: %s\n' "'dsh-mcp-manager'" >> "$PATCH"
  echo "patched -> $PATCH"
else
  echo "mount line already present in $PATCH"
fi

echo
echo "done. Restart 'dsh web' for the new client plugin to load."
