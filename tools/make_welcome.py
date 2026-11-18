"""Writes web/src/welcome.ipynb, the tour notebook bundled with the app."""
import json, sys, uuid

cells = []
def md(src): cells.append({"cell_type": "markdown", "id": uuid.uuid4().hex[:8], "metadata": {}, "source": src})
def code(src): cells.append({"cell_type": "code", "id": uuid.uuid4().hex[:8], "metadata": {}, "source": src, "outputs": [], "execution_count": None})

md("""# Welcome to PyNotebook

This is a Jupyter notebook running **real Python on your device** — no server, no account.

- Tap or click a cell to select it, then press **Run** at the bottom (or Shift+Enter on a keyboard).
- Tap or click a selected cell again to edit it. On a phone, a row of symbols ( `( ) [ ] : = #` … ) sits above the keyboard.
- **Run all** (⏵⏵ at the top) runs every cell in order.
- On a computer, Jupyter's keyboard shortcuts work too: see ⋯ → Keyboard shortcuts.""")
code("""import sys, platform
print("Hello from Python", sys.version.split()[0])
print("Running on", platform.system(), platform.machine())""")
md("""## Variables carry over between cells

The last line of a cell is shown automatically, just like in Jupyter.""")
code("""numbers = [3, 1, 4, 1, 5, 9, 2, 6]
sorted(numbers)""")
code("""mean = sum(numbers) / len(numbers)
f"The mean is {mean:.2f}\"""")
md("""## Math in text cells

Text cells use Markdown. Put LaTeX between dollar signs: $e^{i\\pi} + 1 = 0$, or on its own line:

$$\\int_0^1 x^2 \\, dx = \\frac{1}{3}$$""")
md("""## Asking for input

`input()` shows a text box right under the cell.""")
code("""name = input("What's your name? ")
print(f"Nice to meet you, {name}!")""")
md("""## Rich output

`display()` and `IPython.display` work for HTML, Markdown, LaTeX and images.""")
code("""from IPython.display import HTML, Markdown, Math, display

display(Markdown("**Bold** Markdown from Python, with math: $\\\\sqrt{2} \\\\approx 1.414$"))
display(Math(r"\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}"))
HTML("<span style='color:#0E6B70;font-weight:600'>HTML output works too.</span>")""")
md("""## Plots and data

numpy, pandas and matplotlib are downloaded the first time you import them (a few MB, so you need internet once). In the apps they are then kept for offline use; to download them ahead of time, use **⋯ → Offline packages**.""")
code("""import numpy as np
import matplotlib.pyplot as plt

x = np.linspace(0, 4 * np.pi, 400)
plt.figure(figsize=(6, 3.2))
plt.plot(x, np.sin(x), label="sin x")
plt.plot(x, np.cos(x) * np.exp(-x / 8), label="damped cos x")
plt.legend()
plt.title("Plots appear under the cell")
plt.show()""")
code("""import pandas as pd

df = pd.DataFrame({
    "city": ["Melbourne", "Sydney", "Brisbane", "Perth"],
    "rain_mm": [603, 1150, 1011, 733],
    "sunny_days": [48, 104, 123, 138],
})
df.sort_values("sunny_days", ascending=False)""")
md("""## More packages

Pure-Python packages from PyPI install with `%pip` (needs internet):""")
code("""%pip install tabulate
from tabulate import tabulate
print(tabulate([["Python", 1991], ["Jupyter", 2014]], headers=["Project", "Year"]))""")
md("""## Files

Your code has a working folder that stays on this device. Use **⋯ → Files** to add files (a CSV, for example) and open them by name. On a computer you can instead pick **Use a folder on this PC** so your code works directly with the files in that folder.""")
code("""with open("notes.txt", "w") as f:
    f.write("Saved inside PyNotebook\\n")

print(open("notes.txt").read())
%ls""")
md("""## Good to know

- A long-running cell can be stopped with **■** at the top.
- Errors point at the line that failed.
- **⋯ → Save as** keeps a copy of this notebook. Open your own `.ipynb` files from the home screen, by dropping them onto the window, or from your file manager with *Open with → PyNotebook*.
- **Split screen** (the two-column button) shows another part of a notebook, another file, or a console beside this one.
- Magics like `%time`, `%timeit`, `%%writefile`, `%pip` and `!ls` work. Shell commands are emulated.""")

nb = {"cells": cells, "metadata": {"kernelspec": {"display_name": "Python 3 (ipykernel)", "language": "python", "name": "python3"},
      "language_info": {"name": "python"}}, "nbformat": 4, "nbformat_minor": 5}
out = sys.argv[1]
with open(out, "w") as f:
    json.dump(nb, f, indent=1, sort_keys=True)
    f.write("\n")
print("wrote", out, len(cells), "cells")
