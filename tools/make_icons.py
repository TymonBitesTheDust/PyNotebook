"""Draws the launcher icons: a notebook cell card with the app's left 'rail' and code lines."""
import os, sys
from PIL import Image, ImageDraw

RES = sys.argv[1]
TEAL = (14, 107, 112, 255)
TEAL_D = (9, 78, 82, 255)
AMBER = (240, 177, 63, 255)
WHITE = (255, 255, 255, 255)
LINE = (14, 107, 112, 255)
S = 8  # supersampling


def foreground(px, mono=False):
    """108dp canvas; artwork kept inside the central 66dp safe zone."""
    W = px * S
    im = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    u = W / 108.0
    # card
    x0, y0, x1, y1 = 27 * u, 29 * u, 81 * u, 79 * u
    if not mono:
        d.rounded_rectangle([x0 + 1.2 * u, y0 + 2 * u, x1 + 1.2 * u, y1 + 2 * u], radius=7 * u, fill=(0, 0, 0, 60))
        d.rounded_rectangle([x0, y0, x1, y1], radius=7 * u, fill=WHITE)
    else:
        d.rounded_rectangle([x0, y0, x1, y1], radius=7 * u, outline=WHITE, width=int(3.2 * u))
    # rail
    rail = AMBER if not mono else WHITE
    d.rounded_rectangle([x0 + 7 * u, y0 + 8 * u, x0 + 11 * u, y1 - 8 * u], radius=2 * u, fill=rail if mono else TEAL)
    # code lines
    col = LINE if not mono else WHITE
    lx = x0 + 16 * u
    # a ">" prompt, then code lines of varied length
    cy = y0 + 13.6 * u
    w = 3.6 * u
    d.line([(lx, cy - 4.4 * u), (lx + 5 * u, cy), (lx, cy + 4.4 * u)], fill=(AMBER if not mono else WHITE), width=int(w), joint="curve")
    for px_, py_ in ((lx, cy - 4.4 * u), (lx + 5 * u, cy), (lx, cy + 4.4 * u)):
        d.ellipse([px_ - w / 2, py_ - w / 2, px_ + w / 2, py_ + w / 2], fill=(AMBER if not mono else WHITE))
    d.rounded_rectangle([lx + 10 * u, cy - 2.2 * u, lx + 28 * u, cy + 2.2 * u], radius=2.2 * u, fill=col)
    rows = [(14.0, 22), (23.0, 28), (32.0, 14)]
    for dy, ln in rows:
        y = y0 + 9 * u + dy * u
        d.rounded_rectangle([lx, y, lx + ln * u, y + 4.4 * u], radius=2.2 * u, fill=col)
    return im.resize((px, px), Image.LANCZOS)


def legacy(px):
    W = px * S
    im = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    pad = W * 0.04
    d.rounded_rectangle([pad, pad, W - pad, W - pad], radius=W * 0.22, fill=TEAL)
    fg = foreground(int(W / (66 / 108) * 0.92) // S * S // S * S if False else px, False)
    big = foreground(px * 1, False).resize((W, W), Image.LANCZOS)
    # scale the 108dp foreground so its 66dp safe zone fills ~92% of the legacy icon
    scale = 1.0 / (66 / 108) * 0.86
    size = int(W * scale)
    big = foreground(max(1, size // S), False).resize((size, size), Image.LANCZOS)
    off = (W - size) // 2
    im.alpha_composite(big, (off, off))
    return im.resize((px, px), Image.LANCZOS)


def rounded_tile(px):
    """Square app tile (web favicon, Windows icon): teal rounded square with the card."""
    W = px * S
    im = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, W - 1, W - 1], radius=W * 0.2, fill=TEAL)
    scale = 1.0 / (66 / 108) * 0.92
    size = int(W * scale)
    fg = foreground(max(1, size // S), False).resize((size, size), Image.LANCZOS)
    off = (W - size) // 2
    im.alpha_composite(fg, (off, off))
    return im.resize((px, px), Image.LANCZOS)


extra = {a.split("=", 1)[0]: a.split("=", 1)[1] for a in sys.argv[3:] if "=" in a}
if "--web" in extra:
    rounded_tile(192).save(extra["--web"])
if "--ico" in extra:
    big = rounded_tile(256)
    big.save(extra["--ico"], format="ICO", sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64), (128, 128), (256, 256)])

dens = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
for name, f in dens.items():
    d = os.path.join(RES, f"mipmap-{name}")
    os.makedirs(d, exist_ok=True)
    foreground(int(108 * f)).save(os.path.join(d, "ic_launcher_foreground.png"))
    foreground(int(108 * f), mono=True).save(os.path.join(d, "ic_launcher_monochrome.png"))
    legacy(int(48 * f)).save(os.path.join(d, "ic_launcher.png"))
# a preview for review
prev = Image.new("RGBA", (432 * 2 + 192 + 60, 432), (243, 246, 245, 255))
bg = Image.new("RGBA", (432, 432), TEAL)
bg.alpha_composite(foreground(432))
mask = Image.new("L", (432, 432), 0)
ImageDraw.Draw(mask).ellipse([0, 0, 431, 431], fill=255)
prev.paste(bg, (0, 0), mask)
mono_bg = Image.new("RGBA", (432, 432), (40, 50, 52, 255))
mono_bg.alpha_composite(foreground(432, mono=True))
prev.paste(mono_bg, (452, 0), mask)
prev.alpha_composite(legacy(192), (452 * 2, 120))
prev.save(sys.argv[2] if len(sys.argv) > 2 else "/tmp/icon_preview.png")
print("icons written")
