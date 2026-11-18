#!/usr/bin/env bash
# Builds the Windows versions of PyNotebook:
#   ../build-win/PyNotebook.exe    app window + local server, Python and the app inside
#   ../build-win/PyNotebook.html   single self-contained page
#   ../build-win/pynotebook-linux  the same server for Linux (used by the tests)
# Needs Go 1.22+, Node 18+, Python 3, goversioninfo ($TOOLCHAIN) and Pyodide ($PYODIDE_DIR).
set -euo pipefail
cd "$(dirname "$0")"
HERE=$PWD
ROOT=$(cd .. && pwd)
TC=${TOOLCHAIN:-$HOME/toolchain}
PYODIDE=${PYODIDE_DIR:-$HOME/vendor/pyodide/package}
VERSION=${APP_VERSION:-1.5.0}
OUT=$ROOT/build-win
PYODIDE_VERSION=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$PYODIDE/package.json")
IFS=. read -r V1 V2 V3 <<< "$VERSION"

echo "== web app (served build + single file)"
(cd "$ROOT/web" && APP_VERSION=$VERSION PYODIDE_DIR=$PYODIDE node build.mjs --single)

echo "== embed (gzip)"
rm -rf assets && mkdir -p assets/app assets/pyodide
(cd "$ROOT/web/dist" && find . -type f) | while read -r f; do
  f=${f#./}; mkdir -p "assets/app/$(dirname "$f")"; gzip -9 -n -c "$ROOT/web/dist/$f" > "assets/app/$f.gz"
done
for f in pyodide.mjs pyodide.asm.mjs pyodide.asm.wasm python_stdlib.zip pyodide-lock.json; do
  gzip -9 -n -c "$PYODIDE/$f" > "assets/pyodide/$f.gz"
done
du -sh assets

echo "== Windows resources (icon, version, manifest)"
cat > versioninfo.json <<JSON
{
  "FixedFileInfo": {
    "FileVersion": {"Major": $V1, "Minor": $V2, "Patch": $V3, "Build": 0},
    "ProductVersion": {"Major": $V1, "Minor": $V2, "Patch": $V3, "Build": 0},
    "FileFlagsMask": "3f", "FileFlags": "00", "FileOS": "040004", "FileType": "01", "FileSubType": "00"
  },
  "StringFileInfo": {
    "CompanyName": "PyNotebook",
    "FileDescription": "PyNotebook - Jupyter notebooks and Python",
    "FileVersion": "$VERSION",
    "InternalName": "PyNotebook",
    "LegalCopyright": "PyNotebook. Python by the PSF, Pyodide by the Pyodide project.",
    "OriginalFilename": "PyNotebook.exe",
    "ProductName": "PyNotebook",
    "ProductVersion": "$VERSION"
  },
  "VarFileInfo": {"Translation": {"LangID": "0409", "CharsetID": "04B0"}},
  "IconPath": "pynotebook.ico",
  "ManifestPath": "app.manifest"
}
JSON
sed -i "s/version=\"[0-9.]*\" processorArchitecture=\"\*\"\/>/version=\"$VERSION.0\" processorArchitecture=\"*\"\/>/" app.manifest
"$TC/goversioninfo" -64 -o resource_windows_amd64.syso versioninfo.json

echo "== go build"
mkdir -p "$OUT"
LDFLAGS="-s -w -X main.appVersion=$VERSION -X main.pyodideVersion=$PYODIDE_VERSION"
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 GOFLAGS=-mod=mod GOPROXY=off \
  go build -trimpath -ldflags "$LDFLAGS -H=windowsgui" -o "$OUT/PyNotebook.exe" .
CGO_ENABLED=0 GOFLAGS=-mod=mod GOPROXY=off go build -trimpath -ldflags "$LDFLAGS" -o "$OUT/pynotebook-linux" .
cp "$ROOT/web/dist-single/PyNotebook.html" "$OUT/PyNotebook.html"
ls -la "$OUT"
