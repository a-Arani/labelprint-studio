"""Draws the app icon (app/icon.ico) from the same design as web/logo.svg. Needs Pillow; only used when the icon changes."""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "app" / "icon.ico"
S = 1024           # drawn large, then scaled down for each icon size
U = S / 64         # one unit of the 64x64 logo grid


def gradient(size, top, bottom):
    """Diagonal gradient from top-left to bottom-right."""
    g = Image.new("RGB", (size, size))
    px = g.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
    return g


def draw():
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((2 * U, 2 * U, 62 * U, 62 * U), radius=14 * U, fill=255)
    im.paste(gradient(S, (0x3A, 0x86, 0xE8), (0x1A, 0x4C, 0x9E)), (0, 0), mask)
    d = ImageDraw.Draw(im)
    # White tag pointing left, with a punched hole and barcode bars
    tag = [(10.5, 32), (21, 18.9), (22.5, 18), (50, 18), (53, 21), (53, 43), (50, 46), (22.5, 46), (21, 45.1)]
    d.polygon([(x * U, y * U) for x, y in tag], fill=(255, 255, 255, 255))
    d.ellipse((16.6 * U, 29.1 * U, 22.4 * U, 34.9 * U), fill=(0x2A, 0x6C, 0xC7, 255))
    for x, w in ((27, 2.6), (31.4, 1.3), (34.5, 3), (39.3, 1.3), (42.4, 2.4), (46.6, 1.4)):
        d.rectangle((x * U, 24 * U, (x + w) * U, 40 * U), fill=(0x1F, 0x5F, 0xBF, 255))
    return im


if __name__ == "__main__":
    big = draw()
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    big.resize((256, 256), Image.LANCZOS).save(OUT, sizes=[(s, s) for s in sizes])
    print(OUT)
