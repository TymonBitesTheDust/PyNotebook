# PyNotebook

An app that opens Jupyter notebooks (`.ipynb`), shows them the way Jupyter does, and runs their Python on your own device. It also has a Python console and a `.py` script editor. It comes in three forms built from the same code:

| File | Where it runs |
| --- | --- |
| `PyNotebook.apk` | Android phones and tablets |
| `PyNotebook.exe` | Windows 10 and 11: its own window, files opened from File Explorer, packages kept for offline use |
| `PyNotebook.html` | Any computer with Microsoft Edge or Google Chrome: one file, nothing to install |

Python is **CPython 3.14 compiled to WebAssembly (Pyodide 314.0.7)**, bundled inside each of them, so the core language and the standard library work offline. numpy, pandas, matplotlib, scipy, scikit-learn, sympy and ~350 other packages are downloaded the first time you import them.

## Install on Windows

**PyNotebook.exe** needs no installation.

1. Save `PyNotebook.exe` anywhere, for example in Documents, and double-click it.
2. Windows may show "Windows protected your PC", because the exe isn't signed by a publisher Windows knows. Click **More info**, then **Run anyway**.
3. PyNotebook opens in its own Microsoft Edge app window. Edge is part of Windows 10 and 11; if it's missing, Chrome is used, then your default browser.

How the exe behaves:

- **Exiting:** it exits by itself a few seconds after you close its last window.
- **Opening .ipynb from File Explorer:** in Settings, use **Open .ipynb and .py files from File Explorer → Add**, then right-click a notebook → Open with → PyNotebook. Tick "Always use this app" to make it the default. Windows doesn't let apps set themselves as the default, so this last step is yours.
- **Second launch:** double-clicking another notebook while PyNotebook is open opens it in a new window.
- **Where things are kept:** `%LOCALAPPDATA%\PyNotebook`. That folder holds downloaded packages (`packages`), the app window's browser profile (`Browser`) and a log (`pynotebook.log`). Delete it to reset everything.
- **Networking:** the exe only listens on `127.0.0.1` (port 38917 or the next free one). Other computers can't reach it, and requests from other websites are refused.

**PyNotebook.html** is the same app in one file (about 10 MB). Double-click it to open it in your browser. It runs the same way except:

- **Browser:** it needs **Microsoft Edge or Google Chrome**. In Firefox, notebooks open and run, but `input()` doesn't work and files are saved as downloads.
- **Packages:** they download from the Pyodide CDN when imported. Your browser caches them, so they usually work offline afterwards, but there is no Offline packages manager.
- **Stopping a running cell** restarts Python, as on phones whose WebView lacks interrupt support.
- **Saving:** Save writes back to the file you opened, after Edge/Chrome asks your permission once.

## Install on Android

1. Copy `PyNotebook.apk` to the phone and open it.
2. Allow installing from that source when Android asks (Settings → Apps → Special access → Install unknown apps).
3. Requires Android 7.0+ and an up-to-date **Android System WebView** (update it from the Play Store if Python doesn't start).

## Features

**Reading notebooks**
- Markdown cells with tables, images, attachments and LaTeX math (KaTeX).
- Code cells with syntax highlighting.
- Existing outputs: text, coloured tracebacks, HTML (pandas tables), PNG/JPEG/SVG images, Markdown, LaTeX, JSON.
- Outline panel built from the headings.
- Opens from the home screen, the recent list, or any file manager via *Open with → PyNotebook*.
- Notebook format 3 files are converted on open.

**Running code**
- Run a cell, run all, run above, run this and below, restart, and restart & run all.
- The last expression of a cell is displayed, as in Jupyter.
- `display()`, `IPython.display` (HTML, Markdown, Math, Latex, Image, JSON, Audio) and `clear_output()` work, including display handles.
- matplotlib plots appear inline under the cell.
- `input()` and `getpass()` show a text box under the cell.
- Top-level `await` works.
- Interrupt with ■. On WebViews without SharedArrayBuffer, stopping a cell means restarting Python.
- Magics:
  - Line magics: `%pip install`, `%time`, `%timeit`, `%who`, `%whos`, `%reset`, `%env`, `%cd`, `%pwd`, `%ls`, `%run`, `%matplotlib` and `obj?`.
  - Cell magics: `%%time`, `%%timeit`, `%%capture`, `%%writefile`, `%%html`, `%%markdown`, `%%latex` and `%%bash`.
  - `!` shell commands are emulated: `ls`, `cat`, `head`, `mkdir`, `rm`, `cp`, `mv` and similar.
- Autocomplete from the live Python session.
- A symbol bar above the keyboard with Tab, brackets, `:`, `=`, quotes, cursor keys and Run.

**Typing help** (notebook cells, the console and scripts)

- **Suggestions while typing:** type a few letters and matching names appear. For example, "pr" offers `print` and shows how to call it.
  - Tap a suggestion, or press Tab (⇥ on the phone's symbol bar), to insert it. Functions come with `()` and the cursor inside.
  - Nothing is pre-selected, so Enter still starts a new line.
  - Suggestions cover Python's keywords and built-ins (even before Python has started), names from your running code and other cells, attributes after a dot (`math.fl` → `floor`), and module names after `import`.
- **Mistakes marked while typing:** the line with a problem gets a coloured edge, the exact spot is underlined, and a bar under the code says what's wrong. Tap the bar to jump to the problem.
  - Red marks syntax errors, in Python's own words: `'(' was never closed`, `expected ':'`, `unterminated string literal`, `expected an indented block…`, `Perhaps you forgot a comma?`
  - Amber marks names that aren't defined anywhere in the notebook or the running session, and misspelt module functions. When there's a likely fix, a **Change to …** button applies it (`pirnt` → `print`, `math.sqroot` → `math.sqrt`).
  - Before Python is ready, a quick built-in check still catches missing brackets, quotes and colons.
- Both can be switched off in Settings.

**Line numbers** (notebooks and `.py` files)

- Turn them on or off from a file's ⋯ menu (**Show line numbers** / **Hide line numbers**), from Settings → Line numbers, or with `L` on a keyboard. The choice applies to every open file and is remembered.
- In a notebook each code cell counts from 1, matching Python's error messages ("Cell In[3], line 2"). Numbers show both when reading and when editing, in the same place, so the code doesn't shift when you tap into a cell.
- Long lines that wrap continue under the code, not under the number. With wrapping off, the numbers stay in view while you scroll sideways.
- Text and raw cells, and the console's input line, aren't numbered.

**Split screen**

Tap the split button (two columns) in a file's top bar, or use ⋯ → Split screen. The screen can show 2–4 panes. Each pane holds one of:

- **The same file, another view:** for example the top of a notebook in one pane and the cell you're working on in another. Each view scrolls and selects on its own. Edits, outputs and new or deleted cells show up in every view immediately. Two views of a `.py` script stay in sync as you type.
- **A different file:** another notebook or script, from Open file, the recent list, or New.
- **A console for this notebook:** shares the notebook's Python, so you can inspect its variables without adding cells.
- **A separate Python console**, with its own Python.

Working with panes:

- **Layout:** panes stack top to bottom on a phone held upright and sit side by side when the screen is wide. You can force either one from ⋯.
- **Resizing:** drag the bar between panes. Double-tap the bar to make the two panes equal.
- **Maximize:** ⋯ → Maximize this pane fills the screen with one pane; ⋯ → Show all panes, or Back, brings the others back.
- **Active pane:** it is the one with the coloured line under its title bar. The Run bar and the symbol bar act on it.
- **Closing:** × closes a pane. You're asked about unsaved changes only when you close a file's last pane. Back leaves edit mode first, then closes the active pane.
- **Memory:** each file has its own Python and only the first file starts Python automatically, so several large notebooks at once can use a lot of memory.

**On a computer (exe and HTML)**

- **Keyboard shortcuts:** Jupyter's command-mode keys work when no cell is being edited.
  - `Shift+Enter` and `Ctrl+Enter` run cells.
  - `↑`/`↓` select a cell and `Enter` edits it; `Esc` stops editing.
  - `A`/`B` add a cell above or below; `D D` deletes it.
  - `M`/`Y`/`R` change the cell type; `I I` interrupts; `O` hides output; `L` shows or hides line numbers; `Ctrl+S` saves.
  - The full list is under ⋯ → Keyboard shortcuts.
- **Opening files:** drop `.ipynb` or `.py` files onto the window to open them. Open file and Save use the Windows file dialogs, and Save writes back to the same file.
- **Folders:** Files → **Use a folder on this PC** makes that folder Python's working folder, so `open("data.csv")` or `pd.read_csv("data.csv")` read the real file. Files your code writes appear in the folder.
- **Split screen:** panes sit side by side when the window is wide.
- **Unsaved changes:** closing the window asks first, and drafts are kept.

**Editing and saving**
- Add, move, duplicate, change the type of, and delete cells, with undo for deletes.
- Save writes back to the original file when the providing app allows it; otherwise use Save as.
- Export a notebook as a `.py` script, or open a `# %%` script as a notebook.
- Unsaved edits are kept as drafts if Android closes the app.
- The Files panel holds data files for your code. It lives in the working folder, which persists between sessions.
- Settings: light or dark appearance, a **theme colour** (Teal, Blue, Purple, Pink, Green or Graphite) that tints the whole app, code font size, line wrapping and line numbers.
- Settings ends with an About card: version, creator, website and a link to this source code.

## Limits

These come from running Python in WebAssembly:

- **Packages:** pure-Python packages from PyPI install with `%pip install`, and the packages Pyodide has built (numpy, pandas, scipy, scikit-learn, matplotlib, Pillow, sympy and others) load automatically. Other packages with C extensions (for example torch or tensorflow) are not available.
- **Threads and processes:** no `threading` parallelism, `multiprocessing` or `subprocess`.
- **Networking:** raw sockets don't work. `pyodide.http.pyfetch` and the patched `requests`/`urllib3` packages can fetch URLs that allow cross-origin requests.
- **Interactive outputs:** widgets (ipywidgets) and JavaScript outputs (Plotly, Bokeh) show their static fallback, or a note when there is none.
- **On Windows:** Python runs inside PyNotebook's window, not as a Windows program. It doesn't use a Python or conda you have installed, can't use the GPU, can't start other programs (`!` commands are emulated), and only sees files you add in Files or the folder you choose there.

## Build from source

The builds use plain command-line tools, without Gradle, Android Studio or Visual Studio:

```
./build.sh            # → build/PyNotebook.apk
windows/build.sh      # → build-win/PyNotebook.exe and build-win/PyNotebook.html
```

`windows/build.sh` needs Go 1.22+ and `goversioninfo` for the icon and version resource. It cross-compiles the exe, so the build can run on Linux.

It needs:

- JDK 17+, Node 18+ and Python 3.
- A toolchain folder (`$TOOLCHAIN`, default `~/toolchain`) containing:
  - `android.jar` (API 35)
  - `aapt2`
  - `dx.jar`, which can be compiled from AOSP `platform/dalvik/dx`, or d8 can be swapped in
  - `apksigner.jar`
- The Pyodide npm package unpacked at `$PYODIDE_DIR` (default `~/vendor/pyodide/package`).
- `npm install` run in `web/`.

The APK is signed with `android/keys/pynotebook.keystore`. Its password comes from the `KS_PASS` environment variable or from `android/keys/pynotebook.pass`. Neither the key nor its password is **in this repository**: anyone who had both could sign apps that install as updates to PyNotebook. Keep private copies of both and put them at those paths before building. Without a key, `build.sh` makes a new one with a random password, and phones that have a PyNotebook signed with the old key must uninstall it before installing the new build.

Layout:

| Path | What it is |
| --- | --- |
| `android/` | Manifest, resources, and `MainActivity.java`. The activity hosts the WebView, serves the assets at `https://appassets.androidplatform.net`, fetches and caches packages from the CDN, and answers file open/save requests through the Storage Access Framework. |
| `windows/` | `PyNotebook.exe` (Go, standard library only). It serves the embedded app and Python on 127.0.0.1, opens an Edge app window, reads and writes files passed on the command line, caches packages, and handles "Open with" registration. |
| `web/src/` | The app UI and `worker.js`, which runs Pyodide off the UI thread. Each file type has a document class (model, Python, saving) and a view class (one pane); `workspace.js` holds the split-screen panes. |
| `web/py/` | The Python side of the kernel (`_nbkernel.py`), the inline matplotlib backend and the `IPython` compatibility package. |
| `tests/` | Kernel tests under CPython; browser end-to-end tests (Playwright) for the served app, the single HTML file (`e2e.py --single`), the exe's server (`e2e.py --url`, `e2e_desktop.py`), split screen, and the licences screen with a hostile-notebook check (`e2e_licences.py`); a fake-host test of the Android message protocol. |
| `licenses/` | Licence texts for Pyodide, Python and the libraries built into them, and Go. |

## Licence

PyNotebook is free software under the [MIT licence](LICENSE).

The apps include open-source software that keeps its own licence: Pyodide (MPL-2.0), Python (PSF), CodeMirror, KaTeX, marked, DOMPurify, the JetBrains Mono font, and Go in the Windows exe. [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) has every component and licence text. The same list is in the app under **Settings → About → Licence**.

The notices are generated by `web/build.mjs` from what is actually bundled, and the build stops if a bundled package has no licence file. Texts for Pyodide, Python and the libraries built into them live in `licenses/`. Run `python3 tools/update_licences.py` to refresh them after updating Pyodide or Go.

Python packages you import later, such as numpy or pandas, are downloaded from the Pyodide project and come with their own licences.

## About

PyNotebook is made by Tymon Ng in Australia and built with Claude AI. Website: [tymon.website](https://tymon.website).

© 2026 Tymon Ng. Python is by the Python Software Foundation and Pyodide by the Pyodide project.
