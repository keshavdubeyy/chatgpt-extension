#!/bin/sh
# Builds the Chrome Web Store upload: dist/mell-<version>.zip
# Contains only what the extension needs to run.
set -e
cd "$(dirname "$0")"

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
OUT="dist/mell-$VERSION.zip"

# Safety checks before packaging.
grep -q 'const DRY_RUN = false;' content.js || { echo "DRY_RUN must be false in content.js"; exit 1; }
grep -q 'const DEBUG = false;' content.js   || { echo "DEBUG must be false in content.js"; exit 1; }
for f in manifest.json content.js styles.css icons/icon-16.png icons/icon-32.png icons/icon-48.png icons/icon-128.png; do
  [ -f "$f" ] || { echo "Missing $f"; exit 1; }
done

mkdir -p dist
rm -f "$OUT"
zip -q -X "$OUT" manifest.json content.js styles.css icons/icon-16.png icons/icon-32.png icons/icon-48.png icons/icon-128.png
echo "Built $OUT"
unzip -l "$OUT"
