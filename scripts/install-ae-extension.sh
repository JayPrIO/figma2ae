#!/bin/sh
# Installs the Figma2AE After Effects panel for the current user (macOS).
#   - copies io.jaypr.figma2ae into ~/Library/Application Support/Adobe/CEP/extensions
#   - enables PlayerDebugMode for CSXS 9–13 (required for unsigned CEP extensions)
#   - clears the download quarantine flag so macOS doesn't block the panel's files
# Usage: sh install.sh [--uninstall]
set -eu

EXT_ID="io.jaypr.figma2ae"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/$EXT_ID"
[ -d "$SRC" ] || SRC="$HERE/../dist/ae-extension/$EXT_ID"
DEST_ROOT="$HOME/Library/Application Support/Adobe/CEP/extensions"
DEST="$DEST_ROOT/$EXT_ID"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This installer targets macOS. On Windows copy $EXT_ID to %APPDATA%\\Adobe\\CEP\\extensions" >&2
  exit 1
fi

if [ "${1:-}" = "--uninstall" ]; then
  rm -rf "$DEST"
  echo "✔ Removed $DEST"
  exit 0
fi

if [ ! -d "$SRC" ]; then
  echo "✖ Cannot find $EXT_ID next to this script. Run 'make build' first or unzip the release." >&2
  exit 1
fi

if pgrep -xq "After Effects" 2>/dev/null; then
  echo "⚠ After Effects is running — restart it after installing to load the panel."
fi

mkdir -p "$DEST_ROOT"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

for v in 9 10 11 12 13; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1
done

echo "✔ Installed to: $DEST"
echo "  Restart After Effects, then open Window ▸ Extensions ▸ Figma2AE"
