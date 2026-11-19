#!/usr/bin/env bash
# Builds PyNotebook.apk without Gradle: web bundle -> javac -> dx -> aapt2 -> zip -> apksigner.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$PWD
TC=${TOOLCHAIN:-$HOME/toolchain}          # android.jar, aapt2, dx.jar, apksigner.jar
PYODIDE=${PYODIDE_DIR:-$HOME/vendor/pyodide/package}
VERSION_NAME=${VERSION_NAME:-1.5.1}
VERSION_CODE=${VERSION_CODE:-6}
MIN_SDK=24
TARGET_SDK=35
OUT=$ROOT/build
# Signing key and its password: both private, both kept out of git (android/keys/ is ignored).
# The password comes from $KS_PASS or android/keys/pynotebook.pass.
KEYSTORE=$ROOT/android/keys/pynotebook.keystore
KS_PASS_FILE=$ROOT/android/keys/pynotebook.pass
if [ -z "${KS_PASS:-}" ] && [ -f "$KS_PASS_FILE" ]; then KS_PASS=$(cat "$KS_PASS_FILE"); fi
if [ -f "$KEYSTORE" ] && [ -z "${KS_PASS:-}" ]; then
  echo "error: the signing key's password is missing. Set KS_PASS or put it in android/keys/pynotebook.pass." >&2
  exit 1
fi
export KS_PASS

rm -rf "$OUT" && mkdir -p "$OUT"/{java,classes,assets/web,assets/pyodide}

echo "== web app"
(cd web && APP_VERSION=$VERSION_NAME node build.mjs)
cp -r web/dist/. "$OUT/assets/web/"

echo "== python runtime (Pyodide)"
PYODIDE_VERSION=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$PYODIDE/package.json")
for f in pyodide.mjs pyodide.asm.mjs pyodide.asm.wasm python_stdlib.zip pyodide-lock.json; do
  cp "$PYODIDE/$f" "$OUT/assets/pyodide/"
done
echo "   Pyodide $PYODIDE_VERSION"

echo "== java"
cp -r android/src/. "$OUT/java/"
sed -i "s/@PYODIDE_VERSION@/$PYODIDE_VERSION/g" "$OUT/java/com/pynotebook/app/MainActivity.java"
find "$OUT/java" -name '*.java' > "$OUT/sources.txt"
javac -nowarn -Xlint:-options -source 8 -target 8 -encoding UTF-8 \
  -bootclasspath "$TC/android.jar" -d "$OUT/classes" @"$OUT/sources.txt" 2>&1 | grep -v "JAVA_TOOL_OPTIONS" || true
test -f "$OUT/classes/com/pynotebook/app/MainActivity.class"
java -jar "$TC/dx.jar" --dex --min-sdk-version=$MIN_SDK --output="$OUT/classes.dex" "$OUT/classes" 2>&1 | grep -v "JAVA_TOOL_OPTIONS" || true
test -f "$OUT/classes.dex"

echo "== resources"
"$TC/aapt2" compile --dir android/res -o "$OUT/res.zip"
"$TC/aapt2" link -o "$OUT/base.apk" -I "$TC/android.jar" --manifest android/AndroidManifest.xml \
  --min-sdk-version $MIN_SDK --target-sdk-version $TARGET_SDK \
  --version-code $VERSION_CODE --version-name "$VERSION_NAME" "$OUT/res.zip"

echo "== package"
python3 tools/assemble_apk.py "$OUT/base.apk" "$OUT/classes.dex" "$OUT/assets" "$OUT/unsigned.apk"

echo "== sign"
if [ ! -f "$KEYSTORE" ]; then
  # First build on this machine: make a new key with a random password. Back up both
  # files somewhere private; without them, later builds can't update installed copies.
  mkdir -p "$(dirname "$KEYSTORE")"
  KS_PASS=${KS_PASS:-$(python3 -c "import secrets; print(secrets.token_urlsafe(24))")}
  export KS_PASS
  (umask 077 && printf '%s' "$KS_PASS" > "$KS_PASS_FILE")
  keytool -genkeypair -keystore "$KEYSTORE" -storepass:env KS_PASS -keypass:env KS_PASS -alias pynotebook \
    -keyalg RSA -keysize 2048 -validity 10950 -dname "CN=PyNotebook, O=PyNotebook" 2>&1 | grep -v JAVA_TOOL || true
  echo "   New signing key: android/keys/pynotebook.keystore, password in android/keys/pynotebook.pass. Back up both."
fi
# env: keeps the password off the command line, where other programs could see it.
java -jar "$TC/apksigner.jar" sign --ks "$KEYSTORE" --ks-key-alias pynotebook --ks-pass env:KS_PASS \
  --key-pass env:KS_PASS --min-sdk-version $MIN_SDK --v1-signing-enabled true --v2-signing-enabled true \
  --out "$OUT/PyNotebook.apk" "$OUT/unsigned.apk" 2>&1 | grep -v JAVA_TOOL || true
java -jar "$TC/apksigner.jar" verify --verbose --min-sdk-version $MIN_SDK "$OUT/PyNotebook.apk" 2>&1 | grep -v JAVA_TOOL
ls -la "$OUT/PyNotebook.apk"
