"""PyNotebook kernel.

Runs notebook cells inside Pyodide (Python compiled to WebAssembly). It is
written so it can also run under ordinary CPython, which is how it is tested.

The host (a Web Worker) calls ``init(bridge, platform)`` once, then
``await execute(code)`` per cell. Output is sent to the host as JSON strings
through ``bridge.send``; ``bridge.input(prompt, password)`` blocks until the
person types a reply and returns ``None`` when the request was interrupted.
"""

import ast
import base64
import builtins
import inspect
import io
import json
import linecache
import os
import pprint
import re
import shlex
import shutil
import sys
import time
import tokenize
import traceback
import types

_bridge = None
_platform = None
_kernel = None
_lock_imports = set()

# --------------------------------------------------------------------------
# messaging


def _send(msg):
    if _kernel is not None and _kernel._capture is not None:
        _kernel._capture.append(msg)
        return
    if _bridge is None:
        return
    _bridge.send(json.dumps(msg, default=str))


class _Stream(io.TextIOBase):
    """sys.stdout / sys.stderr replacement that forwards text to the UI."""

    def __init__(self, name):
        super().__init__()
        self._name = name
        self._buf = []
        self._size = 0
        self._last = 0.0

    @property
    def name(self):
        return "<" + self._name + ">"

    @property
    def encoding(self):
        return "utf-8"

    @property
    def errors(self):
        return "replace"

    def writable(self):
        return True

    def readable(self):
        return False

    def isatty(self):
        return False

    def write(self, s):
        if not isinstance(s, str):
            raise TypeError(f"write() argument must be str, not {type(s).__name__}")
        if not s:
            return 0
        self._buf.append(s)
        self._size += len(s)
        now = time.monotonic()
        if self._size > 16384 or (now - self._last) > 0.05:
            self.flush()
        return len(s)

    def flush(self):
        if self._buf:
            text = "".join(self._buf)
            self._buf = []
            self._size = 0
            self._last = time.monotonic()
            _send({"type": "stream", "name": self._name, "text": text})


class _Stdin(io.TextIOBase):
    def readable(self):
        return True

    def isatty(self):
        return False

    @property
    def encoding(self):
        return "utf-8"

    def readline(self, size=-1):
        r = _read_input("", False, echo=False)
        return r + "\n"

    def read(self, size=-1):
        return self.readline()


def _flush_streams():
    for s in (sys.stdout, sys.stderr):
        try:
            s.flush()
        except Exception:
            pass


def _read_input(prompt, password, echo=True):
    _flush_streams()
    if _bridge is None:
        raise EOFError("input is not available")
    r = _bridge.input(str(prompt), bool(password))
    if r is not None and not isinstance(r, str) and inspect.isawaitable(r):
        # The page answers asynchronously: pause Python until it does (needs JSPI).
        try:
            from pyodide.ffi import can_run_sync, run_sync
        except ImportError:
            can_run_sync = None
        if can_run_sync is None or not can_run_sync():
            raise RuntimeError("input() isn't available in this browser. "
                               "Open PyNotebook in Microsoft Edge or Google Chrome, or use the PyNotebook app.")
        r = run_sync(r)
    if r is None:
        raise KeyboardInterrupt
    r = str(r)
    if echo:
        shown = "·" * min(len(r), 12) if password else r
        sys.stdout.write(f"{prompt}{shown}\n")
    return r


def _input(prompt=""):
    return _read_input(prompt, False)


def _getpass(prompt="Password: ", stream=None):
    return _read_input(prompt, True)


# --------------------------------------------------------------------------
# rich display

_MIME_METHODS = [
    ("text/html", "_repr_html_"),
    ("text/markdown", "_repr_markdown_"),
    ("image/svg+xml", "_repr_svg_"),
    ("image/png", "_repr_png_"),
    ("image/jpeg", "_repr_jpeg_"),
    ("text/latex", "_repr_latex_"),
    ("application/json", "_repr_json_"),
    ("application/javascript", "_repr_javascript_"),
    ("application/pdf", "_repr_pdf_"),
]
_BINARY = ("image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf")
_PLAIN_CONTAINERS = {dict.__repr__, list.__repr__, tuple.__repr__, set.__repr__, frozenset.__repr__}


def _safe_method(obj, name):
    if inspect.isclass(obj):
        return None
    try:
        m = getattr(obj, name, None)
    except Exception:
        return None
    return m if callable(m) else None


def _pretty(obj):
    try:
        r = repr(obj)
    except Exception as e:  # noqa: BLE001
        return f"<repr failed: {type(e).__name__}: {e}>"
    if len(r) > 79 and getattr(type(obj), "__repr__", None) in _PLAIN_CONTAINERS:
        try:
            r = pprint.pformat(obj, width=79, sort_dicts=False)
        except Exception:
            pass
    return r


def _is_mpl_figure(obj):
    t = type(obj)
    return t.__name__ in ("Figure", "SubFigure") and t.__module__.startswith("matplotlib.figure")


def _png_size(b):
    if b[:8] == b"\x89PNG\r\n\x1a\n" and len(b) >= 24:
        return int.from_bytes(b[16:20], "big"), int.from_bytes(b[20:24], "big")
    return None


def _figure_png(fig):
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight", dpi=fig.dpi * 2)
    data = buf.getvalue()
    md = {}
    size = _png_size(data)
    if size:
        md = {"width": size[0] // 2, "height": size[1] // 2}
    return data, md


def format_obj(obj, include=None, exclude=None):
    """Return (data, metadata) mime bundles for ``obj``, like IPython does."""
    data, md = {}, {}
    m = _safe_method(obj, "_repr_mimebundle_")
    if m is not None:
        try:
            try:
                r = m(include=include, exclude=exclude)
            except TypeError:
                r = m()
            if isinstance(r, tuple):
                d, mdd = r
            else:
                d, mdd = r, {}
            data.update(d or {})
            md.update(mdd or {})
        except Exception:
            _report_formatter_error("_repr_mimebundle_")
    for mime, attr in _MIME_METHODS:
        if mime in data:
            continue
        f = _safe_method(obj, attr)
        if f is None:
            continue
        try:
            r = f()
        except NotImplementedError:
            continue
        except Exception:
            _report_formatter_error(attr)
            continue
        if r is None:
            continue
        if isinstance(r, tuple) and len(r) == 2 and isinstance(r[1], dict):
            r, extra = r
            md[mime] = extra
        data[mime] = r
    if _is_mpl_figure(obj) and "image/png" not in data:
        try:
            png, pmd = _figure_png(obj)
            data["image/png"] = png
            if pmd:
                md["image/png"] = pmd
            if _kernel is not None:
                _kernel._shown_figures.add(id(obj))
        except Exception:
            _report_formatter_error("savefig")
    if "text/plain" not in data:
        data["text/plain"] = _pretty(obj)
    for k in list(data):
        if include is not None and k not in include and k != "text/plain":
            del data[k]
            continue
        if exclude is not None and k in exclude:
            del data[k]
            continue
        v = data[k]
        if k in _BINARY:
            if isinstance(v, (bytes, bytearray, memoryview)):
                data[k] = base64.b64encode(bytes(v)).decode("ascii")
            else:
                data[k] = re.sub(r"\s+", "", str(v))
        elif k == "application/json" or k.endswith("+json"):
            if isinstance(v, (str, bytes)):
                try:
                    data[k] = json.loads(v)
                except Exception:
                    pass
            try:
                json.dumps(data[k])
            except Exception:
                data[k] = json.loads(json.dumps(data[k], default=str))
        elif isinstance(v, bytes):
            data[k] = v.decode("utf-8", "replace")
        elif not isinstance(v, str):
            data[k] = str(v)
    return data, md


def _report_formatter_error(name):
    try:
        sys.stderr.write(f"[display] {name} raised an exception:\n")
        traceback.print_exc(file=sys.stderr)
    except Exception:
        pass


_display_counter = [0]


def _new_display_id():
    _display_counter[0] += 1
    return f"disp-{os.getpid() if hasattr(os, 'getpid') else 0}-{time.time_ns()}-{_display_counter[0]}"


class DisplayHandle:
    def __init__(self, display_id=None):
        self.display_id = display_id or _new_display_id()

    def __repr__(self):
        return f"<DisplayHandle display_id={self.display_id}>"

    def display(self, obj, **kwargs):
        display(obj, display_id=self.display_id, **kwargs)

    def update(self, obj, **kwargs):
        update_display(obj, display_id=self.display_id, **kwargs)


def display(*objs, include=None, exclude=None, metadata=None, transient=None,
            display_id=None, raw=False, clear=False, **kwargs):
    """Show objects in the cell output (IPython-compatible)."""
    if clear:
        clear_output(wait=True)
    if display_id is True:
        display_id = _new_display_id()
    for obj in objs:
        if raw:
            data, md = dict(obj), dict(metadata or {})
        else:
            data, md = format_obj(obj, include, exclude)
            if metadata:
                md.update(metadata)
        msg = {"type": "display_data", "data": data, "metadata": md}
        tr = dict(transient or {})
        if display_id:
            tr["display_id"] = display_id
        if tr:
            msg["transient"] = tr
        _flush_streams()
        _send(msg)
    if display_id:
        return DisplayHandle(display_id)
    return None


def update_display(obj, *, display_id, **kwargs):
    data, md = format_obj(obj)
    _flush_streams()
    _send({"type": "update_display_data", "data": data, "metadata": md,
           "transient": {"display_id": display_id}})


def publish_display_data(data, metadata=None, source=None, *, transient=None, **kwargs):
    display(data, raw=True, metadata=metadata, transient=transient)


def clear_output(wait=False):
    _flush_streams()
    _send({"type": "clear_output", "wait": bool(wait)})


# --------------------------------------------------------------------------
# get_ipython() shim


class _Events:
    def register(self, *args, **kwargs):
        pass

    def unregister(self, *args, **kwargs):
        pass

    def trigger(self, *args, **kwargs):
        pass


class PyNotebookShell:
    """A small stand-in for IPython's InteractiveShell."""

    def __init__(self, kernel):
        self._k = kernel
        self.events = _Events()
        self.config = {}
        self.kernel = None
        self.display_formatter = None

    @property
    def user_ns(self):
        return self._k.ns

    def run_line_magic(self, magic_name, line, _stack_depth=1):
        return self._k.line_magic(magic_name, line)

    def run_cell_magic(self, magic_name, line, cell):
        return self._k.run_cell_magic_sync(magic_name, line, cell)

    def magic(self, arg_s):
        name, _, line = arg_s.lstrip("%").partition(" ")
        return self._k.line_magic(name, line)

    def system(self, cmd):
        self._k.system(cmd)

    def getoutput(self, cmd):
        return self._k.system(cmd, capture=True)

    def push(self, variables, interactive=True):
        if isinstance(variables, dict):
            self._k.ns.update(variables)

    def ex(self, cmd):
        exec(cmd, self._k.ns)

    def ev(self, expr):
        return eval(expr, self._k.ns)

    def enable_gui(self, gui=None):
        pass

    def enable_matplotlib(self, gui=None):
        return (gui, "inline")

    def has_trait(self, name):
        return False


def get_ipython():
    return _kernel.shell if _kernel is not None else None


# --------------------------------------------------------------------------
# cell transformation (magics, shell escapes, help)


class UsageError(Exception):
    pass


_ASSIGN_MAGIC = re.compile(r"^(\s*)([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*)\s*=\s*([%!])(.*)$")
_LINE_MAGIC = re.compile(r"^(\s*)(%{1}|!)(.*)$")
_HELP = re.compile(r"^(\s*)(\?{0,2})([A-Za-z_][\w.]*)(\?{0,2})\s*$")


def _scan_line(line, state):
    """Track open brackets and triple-quoted strings across lines.

    ``state`` is a dict with keys depth and tq (the open triple quote or None).
    Returns True when the line begins at top level (not inside a string or an
    open bracket) so a magic is allowed there.
    """
    at_top = state["depth"] == 0 and state["tq"] is None and not state.get("cont")
    i, n = 0, len(line)
    tq = state["tq"]
    depth = state["depth"]
    while i < n:
        c = line[i]
        if tq:
            if line.startswith(tq, i):
                tq = None
                i += 3
                continue
            if c == "\\":
                i += 2
                continue
            i += 1
            continue
        if c == "#":
            break
        if c in "\"'":
            if line.startswith(c * 3, i):
                tq = c * 3
                i += 3
                continue
            j = i + 1
            while j < n and line[j] != c:
                j += 2 if line[j] == "\\" else 1
            i = j + 1
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth = max(0, depth - 1)
        i += 1
    state["tq"] = tq
    state["depth"] = depth
    state["cont"] = line.rstrip().endswith("\\") and tq is None
    return at_top


def transform_cell(src):
    """Turn IPython syntax into plain Python, keeping line numbers intact."""
    out = []
    state = {"depth": 0, "tq": None, "cont": False}
    for line in src.split("\n"):
        top = _scan_line(line, state)
        if top:
            new = _transform_line(line)
            if new is not None:
                out.append(new)
                continue
        out.append(line)
    return "\n".join(out)


def _transform_line(line):
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    m = _ASSIGN_MAGIC.match(line)
    if m and not line.lstrip().startswith(("%", "!")):
        indent, target, kind, rest = m.groups()
        if kind == "!":
            return f"{indent}{target} = __nb_k.system({rest!r}, capture=True)"
        name, _, args = rest.partition(" ")
        return f"{indent}{target} = __nb_k.line_magic({name!r}, {args!r})"
    m = _LINE_MAGIC.match(line)
    if m:
        indent, kind, rest = m.groups()
        if kind == "!":
            if rest.startswith("!"):
                rest = rest[1:]
            if re.match(r"\s*pip3?(\s|$)", rest):
                args = re.sub(r"^\s*pip3?\s*", "", rest)
                return f"{indent}await __nb_k.pip({args!r})"
            return f"{indent}__nb_k.system({rest!r})"
        if rest.startswith("%"):
            return None  # cell magic in the middle of a cell: let it be a SyntaxError
        name, _, args = rest.partition(" ")
        if name in ("pip", "pip3", "micropip"):
            return f"{indent}await __nb_k.pip({args!r})"
        return f"{indent}__nb_k.line_magic({name!r}, {args!r})"
    m = _HELP.match(line)
    if m and (m.group(2) or m.group(4)):
        indent, pre, name, post = m.groups()
        level = max(len(pre), len(post))
        return f"{indent}__nb_k.help({name!r}, {level})"
    return None


def _ends_with_semicolon(src):
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    except Exception:
        return src.rstrip().endswith(";")
    for tok in reversed(toks):
        if tok.type in (tokenize.ENDMARKER, tokenize.NEWLINE, tokenize.NL, tokenize.COMMENT,
                        tokenize.INDENT, tokenize.DEDENT):
            continue
        return tok.type == tokenize.OP and tok.string == ";"
    return False


# --------------------------------------------------------------------------
# kernel


class _CapturedIO:
    def __init__(self, msgs):
        self.outputs = msgs

    def _text(self, name):
        return "".join(m["text"] for m in self.outputs if m.get("type") == "stream" and m.get("name") == name)

    @property
    def stdout(self):
        return self._text("stdout")

    @property
    def stderr(self):
        return self._text("stderr")

    def show(self):
        for m in self.outputs:
            _send(m)

    __call__ = show

    def __repr__(self):
        return f"<CapturedIO: {len(self.outputs)} outputs>"


class Kernel:
    def __init__(self):
        self.count = 0
        self.shell = PyNotebookShell(self)
        self._capture = None
        self._shown_figures = set()
        self.ns = {}
        self._reset_ns()

    def _reset_ns(self):
        self.ns.clear()
        self.ns.update({
            "__name__": "__main__",
            "__doc__": None,
            "__builtins__": builtins,
            "display": display,
            "get_ipython": get_ipython,
            "In": [""],
            "Out": {},
            "_": None, "__": None, "___": None,
            "_i": "", "_ii": "", "_iii": "",
            "_ih": None, "_oh": None,
            "__nb_k": self,
            "exit": _Exiter(), "quit": _Exiter(),
        })
        self.ns["_ih"] = self.ns["In"]
        self.ns["_oh"] = self.ns["Out"]
        self._hidden = set(self.ns)
        self.ns.setdefault("__nb_hidden__", True)
        self._hidden.add("__nb_hidden__")

    # -- execution -------------------------------------------------------

    async def execute(self, code, silent=False, fresh=False, store_history=True):
        if fresh:
            self._reset_ns()
        if store_history and not silent:
            self.count += 1
        n = self.count
        filename = f"<cell-{n}>"
        self._shown_figures = set()
        status = "ok"
        err = None
        if store_history and not silent:
            self.ns["In"].append(code)
            self.ns["_iii"], self.ns["_ii"], self.ns["_i"] = self.ns["_ii"], self.ns["_i"], code
            self.ns[f"_i{n}"] = code
        try:
            body = code.lstrip("\n")
            if body.startswith("%%"):
                first, _, cell = body.partition("\n")
                name, _, args = first[2:].partition(" ")
                await self._cell_magic(name.strip(), args.strip(), cell, n, filename, silent)
            else:
                await self._run_code(code, n, filename, display_result=not silent)
        except KeyboardInterrupt as e:
            status, err = "error", self._format_exc(e)
        except BaseException as e:  # noqa: BLE001 - SystemExit etc. are shown, not raised
            status, err = "error", self._format_exc(e)
        finally:
            try:
                self._flush_figures()
            except Exception:
                pass
            _flush_streams()
        if err is not None:
            _send(dict(type="error", **err))
        res = {"status": status, "execution_count": n}
        if err is not None:
            res.update(err)
        return json.dumps(res)

    async def _run_code(self, code, n, filename, display_result=True, ns=None):
        ns = self.ns if ns is None else ns
        pycode = transform_cell(code)
        lines = code.splitlines(True)
        linecache.cache[filename] = (len(code), None, lines, filename)
        if _platform is not None:
            try:
                await _platform.loadImports(pycode)
            except Exception as e:  # noqa: BLE001
                sys.stderr.write(f"Could not load packages: {e}\n")
        tree = ast.parse(pycode, filename=filename, mode="exec")
        expr = None
        if display_result and tree.body and isinstance(tree.body[-1], ast.Expr) \
                and not _ends_with_semicolon(pycode):
            expr = ast.Expression(tree.body.pop().value)
        flags = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
        if tree.body:
            c = compile(tree, filename, "exec", flags=flags, dont_inherit=True)
            r = eval(c, ns)
            if c.co_flags & inspect.CO_COROUTINE:
                await r
        if expr is not None:
            c = compile(expr, filename, "eval", flags=flags, dont_inherit=True)
            val = eval(c, ns)
            if c.co_flags & inspect.CO_COROUTINE:
                val = await val
            self._show_result(val, n)

    def _show_result(self, val, n):
        if val is None:
            return
        ns = self.ns
        ns["___"], ns["__"], ns["_"] = ns["__"], ns["_"], val
        ns["Out"][n] = val
        ns[f"_{n}"] = val
        data, md = format_obj(val)
        _flush_streams()
        _send({"type": "execute_result", "execution_count": n, "data": data, "metadata": md})

    def _flush_figures(self):
        if "matplotlib.pyplot" not in sys.modules:
            return
        try:
            backend = sys.modules["matplotlib"].get_backend()
        except Exception:
            return
        if "_nb_inline_backend" in str(backend):
            mod = sys.modules.get("_nb_inline_backend")
            if mod is not None:
                mod.flush_figures(skip=self._shown_figures)

    def _format_exc(self, e):
        etype = type(e)
        tb = e.__traceback__
        while tb is not None and not tb.tb_frame.f_code.co_filename.startswith("<cell-"):
            tb = tb.tb_next
        if isinstance(e, SyntaxError) or tb is None:
            lines = traceback.format_exception_only(etype, e)
        else:
            lines = traceback.format_exception(etype, e, tb)
        text = "".join(lines).rstrip("\n")
        text = re.sub(r'File "<cell-(\d+)>", line (\d+)', r"Cell In[\1], line \2", text)
        text = text.replace('File "<cell-', 'File "In[')
        hint = self._hint_for(e)
        out = []
        tlines = text.split("\n")
        for i, ln in enumerate(tlines):
            if ln.startswith("Traceback (most recent call last)"):
                out.append("\x1b[31m" + ln + "\x1b[0m")
            elif re.match(r"^\s*Cell In\[\d+\], line \d+", ln):
                out.append("\x1b[32m" + ln + "\x1b[0m")
            elif i == len(tlines) - 1 or re.match(r"^[A-Za-z_][\w.]*(Error|Exception|Interrupt|Exit|Warning)\b", ln):
                name, sep, rest = ln.partition(":")
                out.append("\x1b[1;31m" + name + "\x1b[0m" + sep + rest)
            else:
                out.append(ln)
        if hint:
            out.append("")
            out.append("\x1b[33m" + hint + "\x1b[0m")
        evalue = str(e)
        if isinstance(e, SystemExit):
            evalue = str(e.code) if e.code is not None else ""
        return {"ename": etype.__name__, "evalue": evalue, "traceback": out}

    def _hint_for(self, e):
        if isinstance(e, ModuleNotFoundError) and e.name:
            top = e.name.split(".")[0]
            if top in _lock_imports:
                return (f"'{top}' comes with PyNotebook but hasn't been downloaded yet. "
                        "Connect to the internet and run the cell again; after that it works offline.")
            return f"Try installing it from PyPI with:  %pip install {top}"
        if isinstance(e, KeyboardInterrupt):
            return "Execution was interrupted."
        return None

    # -- cell magics -----------------------------------------------------

    async def _cell_magic(self, name, args, cell, n, filename, silent):
        if name == "time":
            t0, c0 = time.perf_counter(), time.process_time()
            try:
                await self._run_code(cell, n, filename, display_result=not silent)
            finally:
                self._print_times(t0, c0)
        elif name == "timeit":
            setup = args or "pass"
            self._timeit(cell, setup_src=setup, opts="")
        elif name in ("capture",):
            parts = args.split()
            opts = [p for p in parts if p.startswith("-")]
            var = next((p for p in parts if not p.startswith("-")), None)
            self._capture = []
            try:
                await self._run_code(cell, n, filename, display_result="--no-display" not in opts)
                _flush_streams()
            finally:
                msgs, self._capture = self._capture, None
            if var:
                self.ns[var] = _CapturedIO(msgs)
        elif name in ("html", "HTML"):
            display(_Rich("text/html", cell))
        elif name in ("markdown", "md"):
            display(_Rich("text/markdown", cell))
        elif name == "latex":
            display(_Rich("text/latex", cell))
        elif name == "svg":
            display(_Rich("image/svg+xml", cell))
        elif name in ("javascript", "js"):
            sys.stderr.write("JavaScript cells can't run in PyNotebook.\n")
        elif name == "writefile":
            parts = shlex.split(args)
            append = "-a" in parts or "--append" in parts
            fname = next((p for p in parts if not p.startswith("-")), None)
            if not fname:
                raise UsageError("%%writefile needs a file name")
            existed = os.path.exists(fname)
            with open(os.path.expanduser(fname), "a" if append else "w") as f:
                f.write(cell if cell.endswith("\n") or not cell else cell + "\n")
            print(("Appending to " if append else ("Overwriting " if existed else "Writing ")) + fname)
        elif name in ("bash", "sh", "script", "system"):
            for ln in cell.split("\n"):
                if ln.strip():
                    self.system(ln)
        elif name == "python" or name == "python3":
            await self._run_code(cell, n, filename, display_result=False, ns={"__name__": "__main__"})
        else:
            raise UsageError(f"Cell magic `%%{name}` is not available in PyNotebook.")

    def run_cell_magic_sync(self, name, line, cell):
        if name in ("html", "HTML", "markdown", "latex", "svg"):
            mime = {"html": "text/html", "HTML": "text/html", "markdown": "text/markdown",
                    "latex": "text/latex", "svg": "image/svg+xml"}[name]
            display(_Rich(mime, cell))
            return None
        raise UsageError(f"run_cell_magic('{name}') is not supported here")

    # -- line magics -----------------------------------------------------

    def line_magic(self, name, args):
        args = self._expand(args)
        fn = getattr(self, "_m_" + name, None)
        if fn is None:
            if name in _NOOP_MAGICS:
                return None
            raise UsageError(f"Line magic function `%{name}` is not available in PyNotebook.")
        return fn(args)

    def _m_matplotlib(self, args):
        a = args.strip()
        if a and a not in ("inline", "agg"):
            print(f"Using the inline backend ('{a}' isn't available on this device).")
        os.environ["MPLBACKEND"] = "module://_nb_inline_backend"
        mpl = sys.modules.get("matplotlib")
        if mpl is not None:
            try:
                import matplotlib.pyplot as plt
                plt.switch_backend("module://_nb_inline_backend")
            except Exception:
                pass

    _m_pylab = _m_matplotlib

    def _m_time(self, args):
        t0, c0 = time.perf_counter(), time.process_time()
        try:
            try:
                code = compile(args, "<timed exec>", "eval")
                mode = "eval"
            except SyntaxError:
                code = compile(args, "<timed exec>", "exec")
                mode = "exec"
            val = eval(code, self.ns) if mode == "eval" else exec(code, self.ns)
        finally:
            self._print_times(t0, c0)
        return val

    def _print_times(self, t0, c0):
        wall = time.perf_counter() - t0
        cpu = time.process_time() - c0
        print(f"CPU times: total: {_fmt_time(cpu)}\nWall time: {_fmt_time(wall)}")

    def _m_timeit(self, args):
        opts, stmt = _split_opts(args, {"-n", "-r"})
        self._timeit(stmt, setup_src="pass", opts=opts)

    def _timeit(self, stmt, setup_src="pass", opts=None):
        import timeit
        opts = opts if isinstance(opts, dict) else {}
        t = timeit.Timer(stmt, setup_src, globals=self.ns)
        repeat = int(opts.get("-r", 7))
        if "-n" in opts:
            number = int(opts["-n"])
        else:
            number = 1
            for i in range(0, 10):
                number = 10 ** i
                if t.timeit(number) >= 0.2:
                    break
        runs = [x / number for x in t.repeat(repeat=repeat, number=number)]
        mean = sum(runs) / len(runs)
        std = (sum((x - mean) ** 2 for x in runs) / len(runs)) ** 0.5
        print(f"{_fmt_time(mean)} ± {_fmt_time(std)} per loop (mean ± std. dev. of "
              f"{repeat} run{'s' if repeat != 1 else ''}, {number:,} loop{'s' if number != 1 else ''} each)")

    def _user_vars(self):
        return {k: v for k, v in self.ns.items()
                if not k.startswith("_") and k not in self._hidden and not isinstance(v, types.ModuleType)}

    def _m_who(self, args):
        names = sorted(self._user_vars())
        print("\t".join(names) if names else "Interactive namespace is empty.")

    def _m_who_ls(self, args):
        return sorted(self._user_vars())

    def _m_whos(self, args):
        v = self._user_vars()
        if not v:
            print("Interactive namespace is empty.")
            return
        rows = [(k, type(x).__name__, _short(x)) for k, x in sorted(v.items())]
        w1 = max(8, max(len(r[0]) for r in rows))
        w2 = max(4, max(len(r[1]) for r in rows))
        print(f"{'Variable':<{w1}}   {'Type':<{w2}}   Data/Info")
        print("-" * (w1 + w2 + 16))
        for r in rows:
            print(f"{r[0]:<{w1}}   {r[1]:<{w2}}   {r[2]}")

    def _m_reset(self, args):
        keep_count = self.count
        self._reset_ns()
        self.count = keep_count
        if "-f" not in args.split():
            print("Namespace cleared.")

    def _m_env(self, args):
        a = args.strip()
        if not a:
            return dict(os.environ)
        if "=" in a or " " in a:
            k, _, v = a.partition("=") if "=" in a else a.partition(" ")
            os.environ[k.strip()] = v.strip()
            print(f"env: {k.strip()}={v.strip()}")
            return None
        return os.environ.get(a)

    def _m_cd(self, args):
        target = os.path.expanduser(args.strip() or "~")
        os.chdir(target)
        print(os.getcwd())

    def _m_pwd(self, args):
        return os.getcwd()

    def _m_ls(self, args):
        self.system("ls " + args)

    def _m_run(self, args):
        parts = shlex.split(args)
        if not parts:
            raise UsageError("%run needs a file name")
        path = parts[0]
        with open(os.path.expanduser(path)) as f:
            src = f.read()
        old_argv = sys.argv
        sys.argv = parts
        try:
            exec(compile(src, path, "exec"), self.ns if "-i" in parts else {"__name__": "__main__", "__file__": path})
        finally:
            sys.argv = old_argv

    def _m_load(self, args):
        print("%load isn't supported; use %run or open the file.")

    def _m_lsmagic(self, args):
        lines = sorted(n[3:] for n in dir(self) if n.startswith("_m_"))
        print("Line magics: " + "  ".join("%" + n for n in lines))
        print("Cell magics: %%time  %%timeit  %%capture  %%html  %%markdown  %%latex  %%svg  "
              "%%writefile  %%bash  %%python")

    def _m_precision(self, args):
        print("%precision isn't supported in PyNotebook.")

    def _m_history(self, args):
        for i, src in enumerate(self.ns.get("In", [])[1:], 1):
            print(f"{i}: {src}")

    # -- pip -------------------------------------------------------------

    async def pip(self, args):
        args = self._expand(args)
        parts = shlex.split(args)
        if not parts:
            print("Usage: %pip install <package> ...")
            return
        cmd, rest = parts[0], parts[1:]
        if _platform is None:
            print("pip is only available inside the app.")
            return
        await _platform.loadPackages(["micropip"])
        import micropip
        if cmd == "install":
            pkgs, deps, pre, req = [], True, False, None
            i = 0
            while i < len(rest):
                p = rest[i]
                if p in ("-r", "--requirement") and i + 1 < len(rest):
                    req = rest[i + 1]
                    i += 2
                    continue
                if p == "--no-deps":
                    deps = False
                elif p == "--pre":
                    pre = True
                elif p.startswith("-"):
                    pass
                else:
                    pkgs.append(p)
                i += 1
            if req:
                with open(req) as f:
                    pkgs += [ln.split("#")[0].strip() for ln in f if ln.split("#")[0].strip()]
            if not pkgs:
                print("Nothing to install.")
                return
            print("Installing " + ", ".join(pkgs) + " …")
            _flush_streams()
            await micropip.install(pkgs, deps=deps, pre=pre, keep_going=True)
            print("Installed " + ", ".join(pkgs) + ".")
        elif cmd == "uninstall":
            pkgs = [p for p in rest if not p.startswith("-")]
            micropip.uninstall(pkgs)
            print("Uninstalled " + ", ".join(pkgs) + ".")
        elif cmd in ("list", "freeze"):
            for name, dist in sorted(micropip.list().items()):
                ver = getattr(dist, "version", "")
                print(f"{name}=={ver}" if cmd == "freeze" else f"{name:<30} {ver}")
        elif cmd == "show":
            for name in rest:
                d = micropip.list().get(name)
                print(f"Name: {name}\nVersion: {getattr(d, 'version', '?')}" if d else f"Package not found: {name}")
        else:
            print(f"pip {cmd} isn't supported here. Use install, uninstall, list or show.")

    # -- help ------------------------------------------------------------

    def help(self, expr, level=1):
        try:
            obj = eval(expr, self.ns)
        except Exception:
            print(f"Object `{expr}` not found.")
            return
        out = []
        out.append(f"Type:      {type(obj).__name__}")
        try:
            s = repr(obj)
            out.append(f"String form: {s if len(s) < 200 else s[:200] + '...'}")
        except Exception:
            pass
        try:
            out.append(f"Signature: {expr}{inspect.signature(obj)}")
        except (TypeError, ValueError):
            pass
        try:
            f = inspect.getfile(obj)
            out.append(f"File:      {f}")
        except TypeError:
            pass
        if level >= 2:
            try:
                out.append("Source:\n" + inspect.getsource(obj))
            except (OSError, TypeError):
                level = 1
        if level < 2:
            doc = inspect.getdoc(obj)
            out.append("Docstring:\n" + (doc or "<no docstring>"))
        print("\n".join(out))

    # -- shell escapes (emulated) ----------------------------------------

    def _expand(self, s):
        ns = self.ns

        def brace(m):
            try:
                return str(eval(m.group(1), ns))
            except Exception:
                return m.group(0)

        def dollar(m):
            name = m.group(1)
            if name in ns:
                return str(ns[name])
            return m.group(0)

        s = re.sub(r"(?<!\{)\{([^{}]+)\}(?!\})", brace, s)
        s = re.sub(r"(?<!\$)\$([A-Za-z_]\w*)", dollar, s)
        return s.replace("$$", "$")

    def system(self, cmd, capture=False):
        cmd = self._expand(cmd)
        buf = io.StringIO() if capture else None
        out = buf if capture else sys.stdout
        for part in re.split(r"\s*(?:&&|;)\s*", cmd.strip()):
            if part:
                _emulate(part, out, self)
        if capture:
            return _SList(buf.getvalue().splitlines())
        return None


class _SList(list):
    @property
    def s(self):
        return " ".join(self)

    @property
    def n(self):
        return "\n".join(self)

    nlstr = n
    spstr = s


class _Exiter:
    def __repr__(self):
        return "Use Restart in the menu to restart Python."

    def __call__(self, *args):
        raise SystemExit(args[0] if args else None)


class _Rich:
    def __init__(self, mime, data):
        self.mime, self.data = mime, data

    def _repr_mimebundle_(self, include=None, exclude=None):
        return {self.mime: self.data, "text/plain": f"<{self.mime} object>"}


_NOOP_MAGICS = {"load_ext", "reload_ext", "unload_ext", "config", "autoreload", "aimport",
                "xmode", "colors", "autocall", "automagic", "doctest_mode", "pdb", "alias_magic",
                "autosave", "qtconsole", "connect_info", "notebook", "store", "tb"}


def _split_opts(args, with_value):
    parts = args.split()
    opts = {}
    i = 0
    while i < len(parts) and parts[i].startswith("-"):
        p = parts[i]
        if p in with_value and i + 1 < len(parts):
            opts[p] = parts[i + 1]
            i += 2
        else:
            opts[p] = True
            i += 1
    return opts, " ".join(parts[i:])


def _fmt_time(t):
    if t >= 1:
        return f"{t:.3g} s"
    for unit, scale in (("ms", 1e3), ("µs", 1e6), ("ns", 1e9)):
        if t * scale >= 1 or unit == "ns":
            return f"{t * scale:.3g} {unit}"
    return f"{t:.3g} s"


def _short(x):
    try:
        if hasattr(x, "shape") and hasattr(x, "dtype"):
            return f"{getattr(x, 'shape', '')} {getattr(x, 'dtype', '')}"
        s = repr(x)
    except Exception:
        return "?"
    s = s.replace("\n", " ")
    return s if len(s) < 60 else s[:57] + "..."


_SHELL_HELP = ("Shell commands are emulated on this device. Available: ls, pwd, cd, cat, head, tail, "
               "echo, mkdir, rm, cp, mv, touch, wc, python, pip, which, clear.")


def _emulate(cmd, out, kernel):
    try:
        parts = shlex.split(cmd)
    except ValueError as e:
        print(f"shell: {e}", file=out)
        return
    if not parts:
        return
    prog, args = parts[0], parts[1:]
    flags = {a for a in args if a.startswith("-") and len(a) > 1}
    paths = [os.path.expanduser(a) for a in args if not (a.startswith("-") and len(a) > 1)]
    try:
        if prog == "ls":
            targets = paths or ["."]
            long = any("l" in f for f in flags)
            show_all = any("a" in f for f in flags)
            for t in targets:
                if os.path.isdir(t):
                    names = sorted(os.listdir(t))
                    if not show_all:
                        names = [n for n in names if not n.startswith(".")]
                    if len(targets) > 1:
                        print(f"{t}:", file=out)
                    for nme in names:
                        p = os.path.join(t, nme)
                        if long:
                            kind = "d" if os.path.isdir(p) else "-"
                            print(f"{kind} {os.path.getsize(p):>10}  {nme}", file=out)
                        else:
                            print(nme + ("/" if os.path.isdir(p) else ""), file=out)
                elif os.path.exists(t):
                    print(t, file=out)
                else:
                    print(f"ls: cannot access '{t}': No such file or directory", file=out)
        elif prog == "pwd":
            print(os.getcwd(), file=out)
        elif prog == "cd":
            os.chdir(paths[0] if paths else os.path.expanduser("~"))
        elif prog == "cat":
            for p in paths:
                with open(p, errors="replace") as f:
                    out.write(f.read())
        elif prog in ("head", "tail"):
            n = 10
            if "-n" in args:
                i = args.index("-n")
                n = int(args[i + 1])
                paths = [os.path.expanduser(a) for a in args[i + 2:]] + [
                    os.path.expanduser(a) for a in args[:i] if not a.startswith("-")]
            for p in paths:
                with open(p, errors="replace") as f:
                    lines = f.readlines()
                out.write("".join(lines[:n] if prog == "head" else lines[-n:]))
        elif prog == "echo":
            print(" ".join(args), file=out)
        elif prog == "mkdir":
            for p in paths:
                os.makedirs(p, exist_ok="-p" in flags)
        elif prog == "rm":
            for p in paths:
                if os.path.isdir(p):
                    if flags & {"-r", "-rf", "-fr", "-R"}:
                        shutil.rmtree(p)
                    else:
                        print(f"rm: cannot remove '{p}': Is a directory", file=out)
                elif os.path.exists(p):
                    os.remove(p)
                elif "-f" not in flags and "-rf" not in flags:
                    print(f"rm: cannot remove '{p}': No such file or directory", file=out)
        elif prog in ("cp", "mv"):
            if len(paths) < 2:
                print(f"{prog}: missing destination", file=out)
                return
            *srcs, dst = paths
            for s in srcs:
                if prog == "mv":
                    shutil.move(s, dst)
                elif os.path.isdir(s):
                    shutil.copytree(s, os.path.join(dst, os.path.basename(s)) if os.path.isdir(dst) else dst)
                else:
                    shutil.copy(s, dst)
        elif prog == "touch":
            for p in paths:
                with open(p, "a"):
                    os.utime(p, None)
        elif prog == "wc":
            for p in paths:
                with open(p, errors="replace") as f:
                    s = f.read()
                print(f"{s.count(chr(10)):>7} {len(s.split()):>7} {len(s):>7} {p}", file=out)
        elif prog in ("python", "python3"):
            if paths:
                kernel._m_run(" ".join(shlex.quote(a) for a in args))
            else:
                print(sys.version, file=out)
        elif prog in ("pip", "pip3"):
            print("Use %pip install <package> (it needs to be the first thing on its line).", file=out)
        elif prog == "which":
            for a in args:
                print(f"/usr/bin/{a}" if a in ("python", "python3", "pip") else f"which: no {a}", file=out)
        elif prog == "clear":
            clear_output()
        elif prog == "nvidia-smi":
            print("No GPU here — this notebook runs on your phone's CPU.", file=out)
        else:
            print(f"{prog}: command not found. {_SHELL_HELP}", file=out)
    except Exception as e:  # noqa: BLE001
        print(f"{prog}: {e}", file=out)


# --------------------------------------------------------------------------
# completion


def _signature(obj):
    """Short call signature for the completion list, or ''."""
    try:
        sig = str(inspect.signature(obj))
    except (TypeError, ValueError):
        return ""
    return sig if len(sig) <= 60 else sig[:57] + "\u2026)"


def complete(code, pos):
    """Return JSON {from, options} for the text before ``pos``.

    Each option has label and type; callables also get ``detail`` (their signature)
    when the list is short, and names the user created are marked ``user``.
    """
    import keyword
    before = code[:pos]
    m = re.search(r"([A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*\.?)$", before)
    if not m:
        return json.dumps({"from": pos, "options": []})
    token = m.group(1)
    ns = _kernel.ns if _kernel is not None else {}
    if "." in token:
        base, _, partial = token.rpartition(".")
        try:
            obj = eval(base, ns) if re.fullmatch(r"[\w.]+", base) else None
        except Exception:
            obj = None
        if obj is None:
            return json.dumps({"from": pos, "options": []})
        try:
            names = dir(obj)
        except Exception:
            names = []
        picked = [n for n in names if n.startswith(partial) and (partial.startswith("_") or not n.startswith("_"))]
        opts = []
        for nme in picked[:300]:
            kind, detail = "property", ""
            try:
                a = getattr(obj, nme)
                kind = "class" if inspect.isclass(a) else ("method" if callable(a) else
                                                          ("namespace" if isinstance(a, types.ModuleType) else "property"))
                if kind == "method" and len(picked) <= 80:
                    detail = _signature(a)
            except Exception:
                pass
            opts.append({"label": nme, "type": kind, "detail": detail})
        return json.dumps({"from": pos - len(partial), "options": opts})
    partial = token
    names = set(ns) | set(dir(builtins)) | set(keyword.kwlist)
    picked = [n for n in sorted(names) if n.startswith(partial) and not n.startswith("__nb")
              and (partial.startswith("_") or not n.startswith("_"))]
    opts = []
    for nme in picked[:300]:
        detail, user = "", False
        if nme in keyword.kwlist:
            kind = "keyword"
        else:
            user = nme in ns and nme not in getattr(_kernel, "_hidden", ())
            v = ns.get(nme, getattr(builtins, nme, None))
            kind = ("class" if inspect.isclass(v) else "function" if callable(v) else
                    "namespace" if isinstance(v, types.ModuleType) else "variable")
            if kind == "function" and len(picked) <= 80:
                detail = _signature(v)
        opts.append({"label": nme, "type": kind, "detail": detail, "user": user})
    return json.dumps({"from": pos - len(partial), "options": opts})


# --------------------------------------------------------------------------
# lint: mistakes shown while typing


_IGNORE_NAME = re.compile(r"^(_+\d*|_i+\d*|_ih|_oh|_dh)$")
_ALWAYS_KNOWN = {"__file__", "__name__", "__builtins__", "__doc__", "display", "get_ipython", "In", "Out", "exit", "quit"}
_ctx_cache = {}


def _lint_source(code):
    """(python_source, line_offset), or (None, 0) for a cell that isn't Python (e.g. %%html)."""
    stripped = code.lstrip("\n")
    if stripped.startswith("%%"):
        lead = code[:len(code) - len(stripped)].count("\n")
        first, _, rest = stripped.partition("\n")
        name = first[2:].split(" ")[0].strip()
        if name in ("time", "capture", "python", "python3", "prun"):
            return transform_cell(rest), lead + 1
        return None, 0
    return transform_cell(code), 0


def _bound_names(tree):
    """Every name a piece of code binds (in any scope), and whether it star-imports."""
    names, star = set(), False
    type_params = tuple(getattr(ast, n) for n in ("TypeVar", "ParamSpec", "TypeVarTuple") if hasattr(ast, n))
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            names.add(node.id)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.arg):
            names.add(node.arg)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for a in node.names:
                if a.name == "*":
                    star = True
                else:
                    names.add(a.asname or a.name.split(".")[0])
        elif isinstance(node, ast.ExceptHandler) and node.name:
            names.add(node.name)
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            names.update(node.names)
        elif isinstance(node, (ast.MatchAs, ast.MatchStar)) and node.name:
            names.add(node.name)
        elif isinstance(node, ast.MatchMapping) and node.rest:
            names.add(node.rest)
        elif type_params and isinstance(node, type_params):
            names.add(node.name)
    return names, star


def _context_names(sources):
    """Names bound by the notebook's other cells (cached per cell source)."""
    names, star = set(), False
    for src in sources or ():
        key = hash(src)
        hit = _ctx_cache.get(key)
        if hit is None:
            try:
                py, _ = _lint_source(src)
                hit = _bound_names(ast.parse(py)) if py else (set(), False)
            except Exception:
                hit = (set(), False)
            if len(_ctx_cache) > 3000:
                _ctx_cache.clear()
            _ctx_cache[key] = hit
        names |= hit[0]
        star = star or hit[1]
    return names, star


def _char_col(lines, lineno, byte_col):
    """AST columns count UTF-8 bytes; the editor counts characters."""
    if 1 <= lineno <= len(lines):
        return len(lines[lineno - 1].encode("utf-8")[:byte_col].decode("utf-8", "replace"))
    return byte_col


def _suggest(name, candidates):
    import difflib
    pool = [c for c in candidates if not c.startswith("_")]
    m = difflib.get_close_matches(name, pool, n=1, cutoff=0.75)
    return m[0] if m else None


def lint(code, context=None):
    """JSON list of problems in ``code``: syntax errors (exactly as Python reports them)
    and names that aren't defined anywhere (in this cell, other cells or the running session).

    Each item: {line, col, endLine, endCol, severity: error|warning, message, fix?}
    (lines 1-based, columns 0-based characters, fix = replacement text for the range).
    """
    import warnings
    src, offset = _lint_source(code)
    if src is None or not src.strip():
        return "[]"
    lines = src.split("\n")
    out = []
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        try:
            compile(src, "<cell>", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT, dont_inherit=True)
            tree = ast.parse(src, "<cell>")
        except SyntaxError as e:
            line = e.lineno or 1
            col = max(0, (e.offset or 1) - 1)
            end_line = e.end_lineno or line
            end_col = (e.end_offset - 1) if e.end_offset and e.end_offset > 0 else col + 1
            out.append({"line": line + offset, "col": col, "endLine": end_line + offset, "endCol": end_col,
                        "severity": "error", "message": e.msg})
            return json.dumps(out)
        except (ValueError, OverflowError, RecursionError, MemoryError) as e:
            out.append({"line": 1 + offset, "col": 0, "endLine": 1 + offset, "endCol": 1, "severity": "error", "message": str(e)})
            return json.dumps(out)
    for w in caught:
        if issubclass(w.category, SyntaxWarning) and w.lineno:
            ln = w.lineno
            width = len(lines[ln - 1]) if 0 < ln <= len(lines) else 1
            out.append({"line": ln + offset, "col": 0, "endLine": ln + offset, "endCol": width,
                        "severity": "warning", "message": str(w.message)})

    ns = _kernel.ns if _kernel is not None else {}
    bound, star = _bound_names(tree)
    # How this cell binds module names: "import a as m" / "import a" (checkable once a is
    # loaded) versus "import a.b" (binds "a", whose attributes may only appear on import).
    plain_imports, dotted = {}, set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.asname or "." not in a.name:
                    plain_imports[a.asname or a.name] = a.name
                else:
                    dotted.add(a.name.split(".")[0])
    ctx_names, ctx_star = _context_names(context)
    if star or ctx_star:
        return json.dumps(out)
    known = bound | ctx_names | set(ns) | set(dir(builtins)) | _ALWAYS_KNOWN
    flagged = 0
    for node in ast.walk(tree):
        if flagged >= 20:
            break
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            name = node.id
            if name in known or _IGNORE_NAME.match(name):
                continue
            fix = _suggest(name, known)
            msg = f"'{name}' isn't defined" + (f". Did you mean '{fix}'?" if fix else "")
            item = {"line": node.lineno + offset, "col": _char_col(lines, node.lineno, node.col_offset),
                    "endLine": node.end_lineno + offset, "endCol": _char_col(lines, node.end_lineno, node.end_col_offset),
                    "severity": "warning", "message": msg}
            if fix:
                item["fix"] = fix
            out.append(item)
            flagged += 1
        elif isinstance(node, ast.Attribute) and isinstance(node.ctx, ast.Load) and isinstance(node.value, ast.Name):
            base = node.value.id
            if base in dotted:
                continue
            if base in bound:
                mod = sys.modules.get(plain_imports.get(base, ""))
            else:
                mod = ns.get(base)
            if not isinstance(mod, types.ModuleType) or "__getattr__" in vars(mod):
                continue
            if hasattr(mod, node.attr):
                continue
            fix = _suggest(node.attr, dir(mod))
            msg = f"module '{mod.__name__}' has no attribute '{node.attr}'" + (f". Did you mean '{fix}'?" if fix else "")
            end = _char_col(lines, node.end_lineno, node.end_col_offset)
            item = {"line": node.end_lineno + offset, "col": max(0, end - len(node.attr)), "endLine": node.end_lineno + offset,
                    "endCol": end, "severity": "warning", "message": msg}
            if fix:
                item["fix"] = fix
            out.append(item)
            flagged += 1
    return json.dumps(out)


# --------------------------------------------------------------------------
# setup


def init(bridge, platform=None, lock_imports=None):
    """Install streams, input() and the IPython shim. Returns the Kernel."""
    global _bridge, _platform, _kernel, _lock_imports
    _bridge = bridge
    _platform = platform
    if lock_imports:
        _lock_imports = set(lock_imports)
    _kernel = Kernel()
    sys.stdout = _Stream("stdout")
    sys.stderr = _Stream("stderr")
    sys.stdin = _Stdin()
    builtins.input = _input
    try:
        import getpass
        getpass.getpass = _getpass
    except Exception:
        pass
    # Pyodide's own matplotlib backend needs a page (DOM); the kernel runs in a worker.
    os.environ["MPLBACKEND"] = "module://_nb_inline_backend"
    os.environ.setdefault("PYTHONUNBUFFERED", "1")
    os.environ.setdefault("TERM", "xterm-color")
    try:
        import warnings
        warnings.simplefilter("default", DeprecationWarning, append=False)
        warnings.filterwarnings("ignore", category=DeprecationWarning, module=r"^(?!__main__)")
    except Exception:
        pass
    return _kernel


async def execute(code, silent=False, fresh=False):
    return await _kernel.execute(code, silent=bool(silent), fresh=bool(fresh))


def interrupt_reset():
    _flush_streams()
