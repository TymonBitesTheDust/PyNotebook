"""IPython.display compatible objects for PyNotebook."""

import base64
import json
import mimetypes
import os

from _nbkernel import (DisplayHandle, clear_output, display, publish_display_data,  # noqa: F401
                       update_display)

__all__ = [
    "display", "clear_output", "update_display", "DisplayHandle", "publish_display_data",
    "DisplayObject", "HTML", "Markdown", "Math", "Latex", "SVG", "JSON", "Javascript", "Image",
    "Pretty", "Code", "TextDisplayObject", "FileLink", "IFrame", "Audio", "Video", "ProgressBar",
    "display_html", "display_markdown", "display_latex", "display_svg", "display_png",
    "display_jpeg", "display_json", "display_javascript", "display_pretty", "set_matplotlib_formats",
]


class DisplayObject:
    _read_flags = "r"

    def __init__(self, data=None, url=None, filename=None, metadata=None):
        if isinstance(data, str) and data.startswith(("http://", "https://")) and url is None:
            url, data = data, None
        elif isinstance(data, str) and filename is None and len(data) < 1024 and os.path.isfile(data):
            filename, data = data, None
        self.data = data
        self.url = url
        self.filename = filename
        self.metadata = metadata or {}
        if self.data is None and self.filename:
            with open(self.filename, self._read_flags) as f:
                self.data = f.read()

    def __repr__(self):
        return f"<{type(self).__module__}.{type(self).__name__} object>"

    def reload(self):
        pass


class TextDisplayObject(DisplayObject):
    def __init__(self, data=None, url=None, filename=None, metadata=None):
        super().__init__(data, url, filename, metadata)
        if isinstance(self.data, bytes):
            self.data = self.data.decode("utf-8", "replace")


class Pretty(TextDisplayObject):
    def _repr_pretty_(self, *a):
        return self.data

    def __repr__(self):
        return str(self.data)


class HTML(TextDisplayObject):
    def __init__(self, data=None, url=None, filename=None, metadata=None):
        if data is not None and hasattr(data, "_repr_html_") and not isinstance(data, str):
            data = data._repr_html_()
        super().__init__(data, url, filename, metadata)

    def _repr_html_(self):
        if self.data is None and self.url:
            return f'<a href="{self.url}">{self.url}</a>'
        return self.data

    def __html__(self):
        return self._repr_html_()


class Markdown(TextDisplayObject):
    def _repr_markdown_(self):
        return self.data


class Math(TextDisplayObject):
    def _repr_latex_(self):
        s = (self.data or "").strip()
        s = s.strip("$")
        return "$\\displaystyle %s$" % s


class Latex(TextDisplayObject):
    def _repr_latex_(self):
        return self.data


class SVG(DisplayObject):
    _read_flags = "rb"

    def _repr_svg_(self):
        d = self.data
        if isinstance(d, bytes):
            d = d.decode("utf-8", "replace")
        if d and "<svg" in d:
            d = d[d.index("<svg"):]
        return d


class JSON(DisplayObject):
    def __init__(self, data=None, url=None, filename=None, expanded=False, metadata=None, root="root", **kw):
        if isinstance(data, str) and not os.path.isfile(data):
            try:
                data = json.loads(data)
            except Exception:
                pass
        super().__init__(data, url, filename, metadata)
        if isinstance(self.data, str):
            try:
                self.data = json.loads(self.data)
            except Exception:
                pass
        self.expanded = expanded
        self.root = root

    def _repr_json_(self):
        return self.data, {"expanded": self.expanded, "root": self.root}


class Javascript(TextDisplayObject):
    def __init__(self, data=None, url=None, filename=None, lib=None, css=None):
        super().__init__(data, url, filename)

    def _repr_javascript_(self):
        return self.data


def _image_format(data):
    if isinstance(data, (bytes, bytearray)):
        b = bytes(data[:16])
        if b.startswith(b"\x89PNG"):
            return "png"
        if b.startswith(b"\xff\xd8"):
            return "jpeg"
        if b.startswith(b"GIF8"):
            return "gif"
        if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
            return "webp"
    return None


class Image(DisplayObject):
    _read_flags = "rb"

    def __init__(self, data=None, url=None, filename=None, format=None, embed=None, width=None,
                 height=None, retina=False, unconfined=False, metadata=None, alt=None):
        if filename is None and url is None and isinstance(data, str) and data.startswith(("http://", "https://")):
            url, data = data, None
        if embed is None:
            embed = url is None
        self.embed = embed
        self.width, self.height, self.retina, self.alt = width, height, retina, alt
        super().__init__(data, url, filename, metadata)
        if isinstance(self.data, str) and self.data and self.filename is None:
            try:
                self.data = base64.b64decode(self.data)
            except Exception:
                pass
        fmt = format or _image_format(self.data)
        if fmt is None and (self.filename or self.url):
            guess = mimetypes.guess_type(self.filename or self.url)[0] or ""
            fmt = guess.split("/")[-1] if guess.startswith("image/") else None
        if fmt == "jpg":
            fmt = "jpeg"
        self.format = fmt or "png"

    def _md(self):
        md = dict(self.metadata)
        if self.width:
            md["width"] = self.width
        if self.height:
            md["height"] = self.height
        if self.alt:
            md["alt"] = self.alt
        return md

    def _repr_mimebundle_(self, include=None, exclude=None):
        if not self.embed or self.data is None:
            w = f' width="{self.width}"' if self.width else ""
            h = f' height="{self.height}"' if self.height else ""
            return {"text/html": f'<img src="{self.url}"{w}{h}/>', "text/plain": repr(self)}, {}
        mime = "image/" + self.format
        if self.format == "svg+xml" or self.format == "svg":
            d = self.data.decode("utf-8", "replace") if isinstance(self.data, bytes) else self.data
            return {"image/svg+xml": d, "text/plain": repr(self)}, {}
        b64 = base64.b64encode(self.data).decode("ascii")
        md = self._md()
        return {mime: b64, "text/plain": repr(self)}, ({mime: md} if md else {})


class Code(TextDisplayObject):
    def __init__(self, data=None, url=None, filename=None, language=None):
        self.language = language or "python"
        super().__init__(data, url, filename)

    def _repr_markdown_(self):
        return f"```{self.language}\n{self.data}\n```"


class FileLink:
    def __init__(self, path, url_prefix="", result_html_prefix="", result_html_suffix=""):
        self.path = path

    def __repr__(self):
        return os.path.abspath(self.path)


class IFrame:
    def __init__(self, src, width, height, extras=None, **kwargs):
        self.src, self.width, self.height = src, width, height

    def _repr_html_(self):
        return f'<a href="{self.src}">{self.src}</a> <em>(embedded pages open in your browser)</em>'


class _Media(DisplayObject):
    _kind = "audio"

    def __init__(self, data=None, url=None, filename=None, embed=None, mimetype=None, **kwargs):
        super().__init__(data if not isinstance(data, str) or not os.path.isfile(data) else None,
                         url, filename or (data if isinstance(data, str) and os.path.isfile(data) else None))
        self.mimetype = mimetype or (mimetypes.guess_type(self.filename or self.url or "")[0]
                                     or f"{self._kind}/{'wav' if self._kind == 'audio' else 'mp4'}")

    def _repr_html_(self):
        if isinstance(self.data, (bytes, bytearray)):
            src = f"data:{self.mimetype};base64," + base64.b64encode(self.data).decode("ascii")
        else:
            src = self.url or ""
        return f'<{self._kind} controls src="{src}"></{self._kind}>'


class Audio(_Media):
    _kind = "audio"

    def __init__(self, data=None, filename=None, url=None, embed=None, rate=None, autoplay=False,
                 normalize=True, element_id=None):
        if data is not None and not isinstance(data, (bytes, str)) and rate is not None:
            data = _make_wav(data, rate, normalize)
            super().__init__(data, url, filename, mimetype="audio/wav")
        else:
            super().__init__(data, url, filename)


class Video(_Media):
    _kind = "video"


def _make_wav(data, rate, normalize=True):
    import io
    import struct
    import wave
    try:
        import numpy as np
        arr = np.asarray(data, dtype=float)
        if arr.ndim > 1:
            arr = arr.T.reshape(-1) if arr.shape[0] < arr.shape[-1] else arr.reshape(-1)
            channels = min(data.shape) if hasattr(data, "shape") else 1
        else:
            channels = 1
        peak = float(np.max(np.abs(arr))) if arr.size else 1.0
        if normalize and peak > 0:
            arr = arr / peak
        ints = (np.clip(arr, -1, 1) * 32767).astype("<i2").tobytes()
    except ImportError:
        vals = list(data)
        channels = 1
        peak = max((abs(v) for v in vals), default=1) or 1
        ints = b"".join(struct.pack("<h", int(max(-1, min(1, v / peak)) * 32767)) for v in vals)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(int(rate))
        w.writeframes(ints)
    return buf.getvalue()


class ProgressBar:
    def __init__(self, total):
        self.total = total
        self._progress = 0
        self.handle = None

    def _repr_html_(self):
        return f'<progress style="width:60%" max="{self.total}" value="{self._progress}"></progress>'

    def display(self):
        self.handle = display(self, display_id=True)

    def update(self):
        if self.handle:
            self.handle.update(self)

    @property
    def progress(self):
        return self._progress

    @progress.setter
    def progress(self, v):
        self._progress = v
        self.update()

    def __iter__(self):
        self.display()
        self._progress = -1
        return self

    def __next__(self):
        self.progress += 1
        if self.progress < self.total:
            return self.progress
        raise StopIteration


def _display_as(mime):
    def fn(*objs, raw=False, metadata=None):
        for o in objs:
            if raw:
                display({mime: o}, raw=True, metadata=metadata)
            else:
                display(o, include=[mime, "text/plain"], metadata=metadata)
    return fn


display_html = _display_as("text/html")
display_markdown = _display_as("text/markdown")
display_latex = _display_as("text/latex")
display_svg = _display_as("image/svg+xml")
display_png = _display_as("image/png")
display_jpeg = _display_as("image/jpeg")
display_json = _display_as("application/json")
display_javascript = _display_as("application/javascript")
display_pretty = _display_as("text/plain")


def set_matplotlib_formats(*formats, **kwargs):
    pass
