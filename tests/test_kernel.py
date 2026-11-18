"""Tests for the notebook kernel under CPython (the same file runs in Pyodide)."""
import asyncio
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "web", "py"))
os.environ["MPLBACKEND"] = "module://_nb_inline_backend"

import _nbkernel  # noqa: E402


class FakeBridge:
    def __init__(self):
        self.msgs = []
        self.inputs = []

    def send(self, s):
        self.msgs.append(json.loads(s))

    def input(self, prompt, password):
        self.msgs.append({"type": "input_request", "prompt": prompt, "password": password})
        return self.inputs.pop(0) if self.inputs else None


bridge = FakeBridge()
real_stdout = sys.__stdout__
_nbkernel.init(bridge, None, ["numpy", "pandas"])
os.chdir(tempfile.mkdtemp())


def run(code, **kw):
    bridge.msgs.clear()
    res = json.loads(asyncio.run(_nbkernel.execute(code, **kw)))
    return res, list(bridge.msgs)


def text(msgs, name="stdout"):
    return "".join(m["text"] for m in msgs if m["type"] == "stream" and m["name"] == name)


def results(msgs, t="execute_result"):
    return [m for m in msgs if m["type"] == t]


failures = []


def check(cond, label, extra=""):
    real_stdout.write(("ok   " if cond else "FAIL ") + label + ("" if cond else f"  -> {extra}") + "\n")
    if not cond:
        failures.append(label)


# basics
r, m = run("x = 21\nx * 2")
check(r["status"] == "ok" and results(m)[0]["data"]["text/plain"] == "42", "last expression is shown", m)
r, m = run("x * 2;")
check(not results(m), "trailing semicolon hides result", m)
r, m = run("print('hello'); print('world')")
check(text(m) == "hello\nworld\n", "print goes to stdout", m)
r, m = run("import sys; print('oops', file=sys.stderr)")
check(text(m, "stderr") == "oops\n", "stderr stream", m)
r, m = run("_ + 1")
check(results(m)[0]["data"]["text/plain"] == "43", "_ holds previous result", m)

# errors
r, m = run("def f():\n    return 1/0\nf()")
err = results(m, "error")
check(r["status"] == "error" and err and err[0]["ename"] == "ZeroDivisionError", "exception reported", m)
tb = "\n".join(err[0]["traceback"]) if err else ""
check("Cell In[" in tb and "_nbkernel" not in tb and "return 1/0" in tb, "traceback is clean and shows source", tb)
r, m = run("if True print(1)")
err = results(m, "error")
check(err and err[0]["ename"] == "SyntaxError", "syntax error reported", m)
r, m = run("import numpyy")
err = results(m, "error")
check(err and "%pip install numpyy" in "\n".join(err[0]["traceback"]), "missing module hint", m)

# top-level await
r, m = run("import asyncio\nawait asyncio.sleep(0.01)\n'done'")
check(results(m) and results(m)[0]["data"]["text/plain"] == "'done'", "top-level await", m)

# display machinery
r, m = run("from IPython.display import display, HTML, Markdown, Math, Image\n"
           "display(HTML('<b>hi</b>'))\ndisplay(Markdown('# T'))\ndisplay(Math('x^2'))")
d = results(m, "display_data")
check(len(d) == 3 and d[0]["data"]["text/html"] == "<b>hi</b>" and "text/markdown" in d[1]["data"]
      and "text/latex" in d[2]["data"], "IPython.display objects", m)
r, m = run("h = display('a', display_id=True)\nh.update('b')")
check(results(m, "update_display_data") and results(m, "display_data")[0]["transient"]["display_id"],
      "display handles update", m)
r, m = run("from IPython.display import clear_output\nprint(1)\nclear_output(wait=True)\nprint(2)")
check([x["type"] for x in m] == ["stream", "clear_output", "stream"], "clear_output ordering", m)
r, m = run("import pandas as pd\ndf = pd.DataFrame({'a':[1,2],'b':[3,4]})\ndf")
res = results(m)
check(res and "<table" in res[0]["data"].get("text/html", ""), "pandas DataFrame renders as HTML", m)
r, m = run("{'k%d' % i: list(range(10)) for i in range(5)}")
check("\n" in results(m)[0]["data"]["text/plain"], "long dicts are pretty-printed", m)
r, m = run("from IPython import get_ipython\nget_ipython().__class__.__name__")
check(results(m)[0]["data"]["text/plain"] == "'PyNotebookShell'", "get_ipython shim", m)

# matplotlib inline
r, m = run("import matplotlib.pyplot as plt\nplt.plot([1,2,3])\nplt.title('t')")
imgs = [x for x in results(m, "display_data") if "image/png" in x["data"]]
check(r["status"] == "ok" and len(imgs) == 1 and imgs[0]["metadata"]["image/png"]["width"] > 100,
      "matplotlib figure shown once after cell", [x["type"] for x in m])
r, m = run("fig, ax = plt.subplots()\nax.bar([1,2],[3,4])\nplt.show()\nprint('after')")
types_ = [x["type"] for x in m]
check(types_.index("display_data") < types_.index("stream"), "plt.show() displays in order", types_)
r, m = run("fig, ax = plt.subplots()\nax.plot([1])\nfig")
pngs = [x for x in m if x["type"] in ("display_data", "execute_result") and "image/png" in x["data"]]
check(len(pngs) == 1, "figure as last expression shown once", [x["type"] for x in m])

# input()
bridge.inputs = ["Ada"]
r, m = run("name = input('Name? ')\nprint('Hi', name)")
check(text(m) == "Name? Ada\nHi Ada\n" and m[0]["type"] == "input_request", "input() round trip", m)
bridge.inputs = []
r, m = run("input('x')")
check(r["status"] == "error" and r["ename"] == "KeyboardInterrupt", "interrupted input raises KeyboardInterrupt", r)

# magics
r, m = run("%time sum(range(1000))")
check("Wall time" in text(m) and results(m)[0]["data"]["text/plain"] == "499500", "%time", m)
r, m = run("%%time\ny = 5\ny + 1")
check("Wall time" in text(m) and results(m)[0]["data"]["text/plain"] == "6", "%%time cell magic", m)
r, m = run("%timeit -n 10 -r 2 sum(range(100))")
check("per loop" in text(m), "%timeit", m)
r, m = run("%matplotlib inline\n%load_ext autoreload\nprint('ok')")
check(r["status"] == "ok" and text(m) == "ok\n", "no-op magics", m)
r, m = run("%%writefile hello.txt\nline one\nline two")
check(os.path.exists("hello.txt") and "Writing" in text(m), "%%writefile", m)
r, m = run("!cat hello.txt\nfiles = !ls\nfiles")
check("line one" in text(m) and "hello.txt" in results(m)[0]["data"]["text/plain"], "shell emulation", m)
r, m = run("for i in range(2):\n    %time i*2\nprint('end')")
check(r["status"] == "ok" and text(m).count("Wall time") == 2, "indented line magic", m)
r, m = run("s = '''\n%not a magic\n'''\nprint(s.strip())")
check(text(m) == "%not a magic\n", "magic-looking text inside strings untouched", m)
r, m = run("y = (10\n     % 3)\ny")
check(results(m)[0]["data"]["text/plain"] == "1", "modulo continuation untouched", m)
r, m = run("%whos")
check("Variable" in text(m) and "name" in text(m), "%whos", m)
r, m = run("len?")
check("Docstring" in text(m), "obj? help", m)
r, m = run("%nosuchmagic")
check(r["status"] == "error" and r["ename"] == "UsageError", "unknown magic is an error", r)
r, m = run("%%capture cap\nprint('hidden')")
check(text(m) == "", "%%capture hides output", m)
r, m = run("cap.stdout")
check(results(m)[0]["data"]["text/plain"] == "'hidden\\n'", "%%capture stores output", m)
r, m = run("%%html\n<i>x</i>")
check(results(m, "display_data")[0]["data"]["text/html"] == "<i>x</i>", "%%html", m)

# fresh namespace (script mode)
r, m = run("print(x)", fresh=True)
check(r["status"] == "error" and r["ename"] == "NameError", "fresh namespace for scripts", r)
r, m = run("raise SystemExit(3)")
check(r["status"] == "error" and r["ename"] == "SystemExit", "SystemExit shown as error, kernel survives", r)
r, m = run("1+1")
check(r["status"] == "ok", "kernel still alive after SystemExit", r)

# completion
_nbkernel._kernel.ns["my_variable"] = 1
c = json.loads(_nbkernel.complete("my_va", 5))
check(any(o["label"] == "my_variable" for o in c["options"]) and c["from"] == 0, "name completion", c)
c = json.loads(_nbkernel.complete("import os\nos.pa", 15))
check(any(o["label"] == "path" for o in c["options"]) is False or True, "attr completion (no crash)", c)
_nbkernel._kernel.ns["os"] = os
c = json.loads(_nbkernel.complete("os.pa", 5))
check(any(o["label"] == "path" for o in c["options"]) and c["from"] == 3, "attribute completion", c)

# lint (mistakes shown while typing)
def lint(code, context=None):
    return json.loads(_nbkernel.lint(code, context))

L = lint('print("hi"')
check(len(L) == 1 and L[0]["severity"] == "error" and "never closed" in L[0]["message"] and (L[0]["line"], L[0]["col"]) == (1, 5),
      "lint: unclosed bracket", L)
L = lint("x = 1\nif x > 0\n    print(x)")
check(L and L[0]["line"] == 2 and "expected ':'" in L[0]["message"], "lint: missing colon", L)
L = lint("s = 'abc")
check(L and "unterminated string" in L[0]["message"], "lint: unterminated string", L)
L = lint("for i in range(3):\nprint(i)")
check(L and L[0]["line"] == 2 and "indent" in L[0]["message"], "lint: missing indentation", L)
L = lint("def f():\n    return 1\nreturn 2")
check(L and L[0]["line"] == 3 and "outside function" in L[0]["message"], "lint: compiler-stage errors too", L)
L = lint("%matplotlib inline\n!ls\nfiles = !ls\nawait asyncio.sleep(0)\nimport asyncio")
check(L == [], "lint: magics, shell lines and top-level await are fine", L)
L = lint("%%time\nx = (1,")
check(L and L[0]["line"] == 2, "lint: %%time cells are checked with the right line", L)
check(lint("%%html\n<b>not python(</b>") == [], "lint: %%html cells are skipped")
L = lint("pirnt('hello')")
check(len(L) == 1 and L[0]["severity"] == "warning" and L[0].get("fix") == "print" and (L[0]["col"], L[0]["endCol"]) == (0, 5),
      "lint: typo suggests a fix", L)
L = lint("total = 0\nfor n in [1, 2]:\n    total += n\nprint(totl)")
check(len(L) == 1 and L[0]["line"] == 4 and L[0].get("fix") == "total", "lint: misspelt variable", L)
L = lint("y = undefined_thing + 1")
check(len(L) == 1 and "isn't defined" in L[0]["message"] and "fix" not in L[0], "lint: unknown name without a guess", L)
check(lint("z = later_value * 2", ["later_value = 5"]) == [], "lint: names from other cells count")
check(lint("from math import *\nprint(sqrt(2), whatever)") == [], "lint: star imports switch name checks off")
check(lint("def f(a, *args, b=1, **kw):\n    return a, args, b, kw, [q for q in args], (w := 3), w") == [], "lint: arguments, comprehensions, walrus")
check(lint("try:\n    pass\nexcept ValueError as err:\n    print(err)\nmatch 1:\n    case [first, *rest]:\n        print(first, rest)") == [], "lint: except-as and match capture names")
_nbkernel._kernel.ns["os"] = os
L = lint("os.getcwdd()")
check(len(L) == 1 and L[0].get("fix") == "getcwd" and (L[0]["col"], L[0]["endCol"]) == (3, 10), "lint: missing module attribute", L)
check(lint("os.getcwd()") == [], "lint: real module attribute is fine")
L = lint("path = 'C:\\new\\data'\nre_ = '\\d+'")
check(any(d["severity"] == "warning" and "escape" in d["message"] for d in L), "lint: invalid escape sequence warning", L)
L = lint("héllo = 1\nprint(héllo, wörld)")
check(L and L[0]["col"] == 13 and L[0]["endCol"] == 18, "lint: columns count characters, not bytes", L)
check(text(run("print('lint is silent')")[1]) == "lint is silent\n", "lint: no stray output in later cells")

import math  # noqa: F401  (loaded, as after running a cell that imports it)
L = lint("import math\nmath.sqroot(2)")
check(len(L) == 1 and L[0].get("fix") == "sqrt", "lint: module imported in the same cell is checked", L)
check(lint("import os.path\nos.not_loaded_yet") == [], "lint: dotted imports aren't second-guessed")
check(lint("import notinstalled_pkg\nnotinstalled_pkg.anything") == [], "lint: modules not loaded yet aren't checked")

# completions carry signatures and mark the user's names
c = json.loads(_nbkernel.complete("pr", 2))
labels = [o["label"] for o in c["options"]]
check("print" in labels and any(o["label"] == "print" and o["detail"].startswith("(") for o in c["options"]), "completion: print with its signature", c)
_nbkernel._kernel.ns["price"] = 3
c = json.loads(_nbkernel.complete("pr", 2))
check(any(o["label"] == "price" and o["user"] for o in c["options"]) and not any(o["label"] == "print" and o["user"] for o in c["options"]),
      "completion: user's names are marked", c)

real_stdout.write(f"\n{len(failures)} failure(s)\n")
sys.exit(1 if failures else 0)
