"""Brand lockups for documentation: the Flowcast mark beside the wordmark, on no background.

The mark path and its two colours have one definition, theme/mark.ts; this script reads them from
there rather than repeating them, and map-client/tests/brandMark.test.mjs fails if the generated
SVGs ever drift from it. The wordmark is Arial Bold converted to outlines, so the files need no
font at view time and render identically everywhere. Arial is the last real face in --font-text
(theme/tokens.css) and shares Helvetica's metrics, so the shapes match what the apps show.

Outputs (docs/images/, transparent throughout):
  logo.svg / logo.png            mark + wordmark, light surfaces (ink #1d1d1f)
  logo-dark.svg / logo-dark.png  the same, dark surfaces (ink #f5f5f7)
  mark.png / mark-dark.png       the mark alone, square

Run: python map-client/scripts/make_logo_assets.py
Needs: fonttools, pillow (both already in data-pipeline/.venv).
"""
from __future__ import annotations

import re
from pathlib import Path

from fontTools.misc.transform import Transform
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs" / "images"
FONT = Path("C:/Windows/Fonts/arialbd.ttf")

WORDMARK = "Flowcast"
EM = 120.0           # wordmark size in SVG units
MARK_OVER_CAP = 1.10  # the mark stands a little taller than the capitals
GAP = 0.22            # space between mark and wordmark, in ems
PAD = 4.0             # breathing room so no rasteriser clips an edge
INK = {"light": "#1d1d1f", "dark": "#f5f5f7"}  # --color-ink per theme


def read_mark() -> tuple[str, dict[str, str]]:
    """The mark path and its per-theme colours, from theme/mark.ts."""
    source = (ROOT / "theme" / "mark.ts").read_text(encoding="utf-8")
    path = re.search(r"MARK_PATH = '([^']+)'", source)
    light = re.search(r"light: '(#[0-9a-fA-F]{6})'", source)
    dark = re.search(r"dark: '(#[0-9a-fA-F]{6})'", source)
    if not (path and light and dark):
        raise SystemExit("theme/mark.ts no longer exposes MARK_PATH and MARK_COLOR")
    return path.group(1), {"light": light.group(1), "dark": dark.group(1)}


def parse_mark(path: str) -> list[tuple[float, float]]:
    """The mark as polygon corners on its 100 x 100 grid: moves and horizontal/vertical lines only."""
    tokens = re.findall(r"[MHVZ]|-?[\d.]+", path)
    points: list[tuple[float, float]] = []
    x = y = 0.0
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token == "M":
            x, y = float(tokens[index + 1]), float(tokens[index + 2])
            index += 3
        elif token == "H":
            x = float(tokens[index + 1])
            index += 2
        elif token == "V":
            y = float(tokens[index + 1])
            index += 2
        else:
            index += 1
            continue
        points.append((x, y))
    return points


def wordmark() -> tuple[str, tuple[float, float, float, float], float, list[tuple[str, float]]]:
    """The wordmark outlined at `EM`, drawn from x=0 on the baseline y=0 (y grows downwards).

    Returns the SVG path, its ink bounds, the font's cap height in the same units, and each
    character with the x it starts at, so the raster pass can place the same glyphs identically.
    """
    font = TTFont(FONT)
    upem = font["head"].unitsPerEm
    scale = EM / upem
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    metrics = font["hmtx"]

    svg_pen = SVGPathPen(glyphs, ntos=lambda value: f"{value:.2f}".rstrip("0").rstrip("."))
    bounds = BoundsPen(glyphs)
    placements: list[tuple[str, float]] = []
    cursor = 0.0
    for character in WORDMARK:
        name = cmap[ord(character)]
        transform = Transform(scale, 0, 0, -scale, cursor, 0)
        glyphs[name].draw(TransformPen(svg_pen, transform))
        glyphs[name].draw(TransformPen(bounds, transform))
        placements.append((character, cursor))
        cursor += metrics[name][0] * scale
    cap = font["OS/2"].sCapHeight * scale
    return svg_pen.getCommands(), bounds.bounds, cap, placements


def main() -> None:
    if not FONT.exists():
        raise SystemExit(f"{FONT} not found; point FONT at an Arial Bold (or Helvetica Bold) file")
    OUT.mkdir(parents=True, exist_ok=True)
    mark_path, mark_colors = read_mark()
    corners = parse_mark(mark_path)
    glyph_path, ink, cap, placements = wordmark()

    size = round(cap * MARK_OVER_CAP, 2)      # the mark's side
    text_x = round(size + EM * GAP, 2)         # where the wordmark starts
    # Everything is laid out against the baseline at y=0; the mark sits on it.
    top = min(-size, ink[1])
    bottom = max(0.0, ink[3])
    width = round(text_x + ink[2] + PAD * 2, 2)
    height = round(bottom - top + PAD * 2, 2)
    baseline = round(-top + PAD, 2)            # baseline position inside the viewBox
    mark_y = round(baseline - size, 2)
    scale = round(size / 100, 5)

    for theme, ink_color in INK.items():
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
            f'width="{width}" height="{height}" role="img" aria-label="Flowcast">\n'
            f"  <title>Flowcast</title>\n"
            f'  <g transform="translate({PAD} {mark_y}) scale({scale})">'
            f'<path fill="{mark_colors[theme]}" d="{mark_path}"/></g>\n'
            f'  <g transform="translate({round(PAD + text_x, 2)} {baseline})">'
            f'<path fill="{ink_color}" d="{glyph_path}"/></g>\n'
            f"</svg>\n"
        )
        (OUT / f"logo{'' if theme == 'light' else '-dark'}.svg").write_text(svg, encoding="utf-8")

    # Rasterised twins at 1200 px wide, supersampled 4x so the mark's edges stay clean.
    target = 1200
    ss = 4
    pixels = (target * ss) / width
    font_px = ImageFont.truetype(str(FONT), int(round(EM * pixels)))
    for theme, ink_color in INK.items():
        image = Image.new("RGBA", (int(round(width * pixels)), int(round(height * pixels))), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        draw.polygon([((PAD + x * scale) * pixels, (mark_y + y * scale) * pixels) for x, y in corners],
                     fill=mark_colors[theme])
        for character, offset in placements:
            draw.text(((PAD + text_x + offset) * pixels, baseline * pixels), character,
                      font=font_px, fill=ink_color, anchor="ls")
        final = image.resize((target, int(round(target * height / width))), Image.LANCZOS)
        final.save(OUT / f"logo{'' if theme == 'light' else '-dark'}.png")
        print(f"logo{'' if theme == 'light' else '-dark'}.png {final.size[0]}x{final.size[1]}")

    # The mark alone, square, with the padding the favicon uses (4 units on a 100 unit grid).
    for theme in INK:
        edge, inset = 512, 4 / 108
        big = Image.new("RGBA", (edge * ss, edge * ss), (0, 0, 0, 0))
        span = edge * ss * (1 - inset * 2)
        ImageDraw.Draw(big).polygon(
            [(edge * ss * inset + x / 100 * span, edge * ss * inset + y / 100 * span) for x, y in corners],
            fill=mark_colors[theme])
        big.resize((edge, edge), Image.LANCZOS).save(OUT / f"mark{'' if theme == 'light' else '-dark'}.png")
    print(f"mark.png / mark-dark.png 512x512")


if __name__ == "__main__":
    main()
