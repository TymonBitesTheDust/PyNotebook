import nbformat
from nbclient import NotebookClient
nb = nbformat.v4.new_notebook()
C, M = nbformat.v4.new_code_cell, nbformat.v4.new_markdown_cell
nb.cells = [
    M("# Real Jupyter output\nThis file was executed by **ipykernel** on a desktop, then opened in PyNotebook.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nInline math $\\alpha^2$ and a block:\n\n$$\\begin{aligned} f(x) &= x^2 \\\\ f'(x) &= 2x \\end{aligned}$$"),
    C("import numpy as np, pandas as pd\nimport matplotlib\nmatplotlib.use('module://matplotlib_inline.backend_inline')\nimport matplotlib.pyplot as plt\nnp.random.seed(0)\ndf = pd.DataFrame(np.random.randn(6, 4), columns=list('ABCD'))\ndf"),
    C("fig, ax = plt.subplots(figsize=(5,3))\nax.plot(df.cumsum())\nax.set_title('cumsum')\nplt.show()"),
    C("for i in range(3):\n    print(f'line {i}')\nimport sys; print('warn!', file=sys.stderr)"),
    C("print('\\x1b[31mred\\x1b[0m and \\x1b[1;32mbold green\\x1b[0m')"),
    C("from IPython.display import Latex, Markdown, display\ndisplay(Latex(r'$\\frac{a}{b}$'))\ndisplay(Markdown('*from python*'))"),
    C("1/0"),
    C("{'key': list(range(30)), 'other': 'x'*50}"),
]
NotebookClient(nb, timeout=120, kernel_name="python3", allow_errors=True).execute()
nbformat.write(nb, "real_outputs.ipynb")
print("ok", sum(len(c.get('outputs', [])) for c in nb.cells), "outputs")
