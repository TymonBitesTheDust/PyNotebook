"""Minimal IPython stand-in so notebooks that import IPython.display keep working."""

from _nbkernel import get_ipython, display  # noqa: F401
from . import display as _display_mod  # noqa: F401

version_info = (8, 30, 0, "")
__version__ = "8.30.0"


def embed(*args, **kwargs):
    print("IPython.embed() isn't available in PyNotebook.")
