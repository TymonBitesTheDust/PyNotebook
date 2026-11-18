"""Downloads the licence texts of the software built into PyNotebook's Python runtime
(and the Windows exe's Go runtime) into licenses/. Run it when Pyodide or Go is updated:

    python3 tools/update_licences.py [path/to/pyodide/package]

The npm packages bundled into the app need no entry here: web/build.mjs reads their
licence files from node_modules. licenses/components.json lists what this script fetches.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "licenses")
PYODIDE = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/vendor/pyodide/package")
RAW = "https://raw.githubusercontent.com/"


def get(path):
    with urllib.request.urlopen(RAW + path, timeout=60) as r:
        return r.read().decode("utf-8")


def rst_to_text(rst):
    """Python's Doc/license.rst as plain text: drop directives and roles, keep the wording."""
    lines = []
    for line in rst.splitlines():
        if re.match(r"^\.\. ", line) or re.match(r"^\s+:[a-z-]+:", line) and lines and lines[-1].startswith(".."):
            continue
        line = re.sub(r":[a-z]+(?::[a-z]+)?:`[!~]?([^`<]*?)(?:\s*<[^>]*>)?`", r"\1", line)
        line = re.sub(r"``([^`]*)``", r"\1", line)
        line = line.replace("|release|", "").replace("|version|", "")
        line = re.sub(r"(\S)::$", r"\1:", line)
        line = re.sub(r"\s+::$", "", line)
        if line.strip() == "::":
            continue
        lines.append(line.rstrip())
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip() + "\n"


def c_comment(src):
    body = src.split("*/", 1)[0].split("/*", 1)[1]
    return "\n".join(re.sub(r"^ ?\* ?", "", l).rstrip() for l in body.splitlines()).strip() + "\n"


def write(name, text):
    with open(os.path.join(OUT, name), "w", encoding="utf-8", newline="\n") as f:
        f.write(text.strip() + "\n")
    print(f"  {name:16} {len(text):>6} chars")


def main():
    os.makedirs(OUT, exist_ok=True)
    pyodide_version = json.load(open(os.path.join(PYODIDE, "package.json")))["version"]
    python_version = ".".join(json.load(open(os.path.join(PYODIDE, "pyodide-lock.json")))["info"]["python"].split(".")[:2])
    print(f"Pyodide {pyodide_version}, Python {python_version}")

    write("pyodide.txt", get(f"pyodide/pyodide/{pyodide_version}/LICENSE"))
    rst = get(f"python/cpython/{python_version}/Doc/license.rst")
    incorporated = rst[rst.index("Licenses and Acknowledgements for Incorporated Software"):]
    write("python.txt", get(f"python/cpython/{python_version}/LICENSE").strip() + "\n\n\n" + rst_to_text(incorporated))
    write("hacl.txt", c_comment(get(f"python/cpython/{python_version}/Modules/_hacl/Hacl_Hash_SHA2.c")))
    write("emscripten.txt", get("emscripten-core/emscripten/main/LICENSE"))
    write("musl.txt", get("emscripten-core/emscripten/main/system/lib/libc/musl/COPYRIGHT"))
    write("bzip2.txt", get("libarchive/bzip2/bzip2-1.0.8/LICENSE"))
    write("xz.txt", get("tukaani-project/xz/master/COPYING"))
    write("zstd.txt", get("facebook/zstd/dev/LICENSE"))
    write("sqlite.txt", "SQLite is in the public domain: anyone may copy, use, change or sell it.\n"
          "See https://sqlite.org/copyright.html\n")

    go = shutil.which("go")
    goroot = subprocess.run([go, "env", "GOROOT"], capture_output=True, text=True).stdout.strip() if go else ""
    if goroot and os.path.exists(os.path.join(goroot, "LICENSE")):
        write("go.txt", open(os.path.join(goroot, "LICENSE"), encoding="utf-8").read())
    else:
        write("go.txt", get("golang/go/master/LICENSE"))


if __name__ == "__main__":
    main()
