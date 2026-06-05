"""Generate og-image.png (1200x630), favicon-32.png, apple-touch-icon.png (180x180)
for Stock Tracker in the quant-terminal palette. Zero-dep beyond Pillow."""
from PIL import Image, ImageDraw, ImageFont
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BG, PANEL, LINE = (15, 20, 25), (22, 30, 38), (42, 55, 68)
INK, SOFT, ACCENT = (230, 237, 243), (159, 176, 191), (63, 182, 168)
UP, DOWN = (74, 222, 128), (255, 131, 137)


def font(size, bold=False):
    names = ["seguisb.ttf" if bold else "segoeui.ttf", "arialbd.ttf" if bold else "arial.ttf"]
    for n in names:
        try:
            return ImageFont.truetype(n, size)
        except OSError:
            continue
    return ImageFont.load_default()


def chart_mark(draw, x, y, w, h, stroke, width):
    # the favicon chart glyph: simple price line
    pts = [(x, y + h * 0.78), (x + w * 0.3, y + h * 0.3), (x + w * 0.5, y + h * 0.55),
           (x + w * 0.78, y + h * 0.12), (x + w, y + h * 0.4)]
    draw.line(pts, fill=stroke, width=width, joint="curve")


def candles(draw, x0, y0, w, h, n=24, seed=7):
    import random
    rng = random.Random(seed)
    cw = w / n
    price = 0.55
    for i in range(n):
        o = price
        c = min(0.95, max(0.05, o + rng.uniform(-0.13, 0.15)))
        hi = max(o, c) + rng.uniform(0.01, 0.06)
        lo = min(o, c) - rng.uniform(0.01, 0.06)
        color = UP if c >= o else DOWN
        cx = x0 + cw * (i + 0.5)
        draw.line([(cx, y0 + h * (1 - hi)), (cx, y0 + h * (1 - lo))], fill=color, width=2)
        top, bot = y0 + h * (1 - max(o, c)), y0 + h * (1 - min(o, c))
        draw.rectangle([cx - cw * 0.32, top, cx + cw * 0.32, max(bot, top + 2)], fill=color)
        price = c


# --- og-image 1200x630 ---
og = Image.new("RGB", (1200, 630), BG)
d = ImageDraw.Draw(og)
d.rounded_rectangle([60, 60, 1140, 570], radius=24, fill=PANEL, outline=LINE, width=2)
for gy in range(160, 540, 90):
    d.line([(100, gy), (1100, gy)], fill=LINE, width=1)
candles(d, 100, 150, 1000, 360, n=30)
d.rounded_rectangle([92, 88, 124, 120], radius=8, fill=BG)
chart_mark(d, 98, 96, 20, 16, ACCENT, 3)
d.text((140, 84), "Stock Tracker", font=font(54, bold=True), fill=INK)
d.text((100, 520), "watchlist · charts · portfolio · relational map · AI analyst",
       font=font(30), fill=SOFT)
og.save(os.path.join(ROOT, "og-image.png"), optimize=True)

# --- favicon-32 + apple-touch-icon 180 ---
for size, pad, lw, name in [(32, 6, 3, "favicon-32.png"), (180, 34, 14, "apple-touch-icon.png")]:
    im = Image.new("RGB", (size, size), BG)
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=size // 5, fill=BG, outline=LINE, width=max(1, size // 60))
    chart_mark(d, pad, pad + size * 0.08, size - 2 * pad, size - 2 * pad - size * 0.16, ACCENT, lw)
    im.save(os.path.join(ROOT, name), optimize=True)

print("assets written:", os.listdir(ROOT))
