"""Matplotlib backend that shows figures inside the notebook (like %matplotlib inline)."""

import matplotlib
from matplotlib._pylab_helpers import Gcf
from matplotlib.backend_bases import FigureManagerBase
from matplotlib.backends.backend_agg import FigureCanvasAgg

FigureCanvas = FigureCanvasAgg
FigureManager = FigureManagerBase


def show(*args, **kwargs):
    flush_figures()


def draw_if_interactive():
    pass


def flush_figures(skip=()):
    managers = Gcf.get_all_fig_managers()
    if not managers:
        return
    import _nbkernel
    try:
        for m in managers:
            fig = m.canvas.figure
            if id(fig) in skip:
                continue
            _nbkernel.display(fig)
    finally:
        import matplotlib.pyplot as plt
        plt.close("all")


# Figures look better on a phone with a white background and a tight layout.
try:
    matplotlib.rcParams["figure.facecolor"] = "white"
except Exception:
    pass
