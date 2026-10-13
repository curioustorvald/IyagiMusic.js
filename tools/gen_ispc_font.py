#!/usr/bin/env python3
"""Build a webfont of the ISPC.FNT glyphs that Unicode has no faithful form for.

Most of Iyagi's user-defined glyphs are CP437's, and any font draws them
well enough.  Three are Iyagi's own, and the code points
``tools/iyagi_user_area.tsv`` gives them are the nearest Unicode has rather
than the glyph itself -- a browser draws an emoji ox for the Hanulso logo, a
tiny "NL" for the boxed return arrow, and emoji soap bubbles for the orb.
This font carries Iyagi's own drawings at those same code points, so a page
that puts it ahead of its text fonts (with ``unicode-range`` limiting it to
those three) shows what the Iyagi screen showed, and the decoded text stays
the same string either way.

The glyphs are redrawn as outlines rather than traced pixel by pixel: each
is a handful of strokes -- curves where the bitmap stair-steps a curve,
straight diagonals where it stair-steps a line -- laid out on the bitmap's
own 16x16 grid in ``SHAPES`` below, then stroked and merged into one outline.
The bitmaps they were read off are in ``docs/ISPC.png``; ``--proof`` draws
each outline over its bitmap, which is how to check an edit to ``SHAPES``.

Source of the code points: the ``unicode`` column of
``tools/iyagi_user_area.tsv``, by glyph number, so the font cannot drift from
what ``src/user-glyphs.js`` decodes to.

Needs Pillow, fontTools, brotli and skia-pathops (and freetype-py for
--proof):
    pip install pillow fonttools brotli skia-pathops freetype-py

Usage:  python3 tools/gen_ispc_font.py               # rewrite fonts/iyagi-ispc.woff2
        python3 tools/gen_ispc_font.py --proof P.png # also draw the proof sheet
"""
import math
import os
import sys

from fontTools.fontBuilder import FontBuilder
from fontTools.misc.timeTools import timestampSinceEpoch
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
import pathops

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

FAMILY = "Iyagi ISPC"
OUT = os.path.join(ROOT, "fonts", "iyagi-ispc.woff2")

# Shapes are written in bitmap pixels: x rightwards and y downwards from the
# glyph's top-left corner, so (3.5, 1.5) is the middle of the pixel in column
# 3, row 1 -- the numbers can be checked straight against docs/ISPC.png.
# One pixel is 64 units, so the 16-pixel glyph is exactly one em, and its
# square sits from 880 down to -144, which centres it where Hangul's middle
# is in the fonts the page falls back to.
SIZE = 16
UNIT = 64
UPEM = SIZE * UNIT
TOP = 880

# The bitmaps draw everything one pixel wide; a stroke of the same width
# keeps the weight the font was designed at.
LINE = 1.0


# ── drawing primitives, in pixels ────────────────────────────────────────

def to_font(p):
    return (p[0] * UNIT, TOP - p[1] * UNIT)


def smooth(points, closed=False):
    """A curve through every point (Catmull-Rom, as cubic Béziers)."""
    path = pathops.Path()
    pen = path.getPen()
    pts = [to_font(p) for p in points]
    n = len(pts)
    pen.moveTo(pts[0])
    last = n if closed else n - 1
    for i in range(last):
        p0 = pts[(i - 1) % n] if (closed or i > 0) else pts[i]
        p1, p2 = pts[i], pts[(i + 1) % n]
        p3 = pts[(i + 2) % n] if (closed or i + 2 < n) else p2
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        pen.curveTo(c1, c2, p2)
    if closed:
        pen.closePath()
    else:
        pen.endPath()
    return path


def polyline(points, closed=False):
    """Straight segments between the points."""
    path = pathops.Path()
    pen = path.getPen()
    pen.moveTo(to_font(points[0]))
    for p in points[1:]:
        pen.lineTo(to_font(p))
    if closed:
        pen.closePath()
    else:
        pen.endPath()
    return path


def arc(cx, cy, rx, ry, start, end):
    """An elliptical arc, angles in degrees clockwise from 3 o'clock (y is
    down), split into quarter-turn-or-less cubic pieces."""
    path = pathops.Path()
    pen = path.getPen()
    pieces = max(1, math.ceil(abs(end - start) / 90))
    step = math.radians(end - start) / pieces

    def at(t):
        return (cx + rx * math.cos(t), cy + ry * math.sin(t))

    def d(t):
        return (-rx * math.sin(t), ry * math.cos(t))

    k = 4 / 3 * math.tan(step / 4)
    t = math.radians(start)
    pen.moveTo(to_font(at(t)))
    for _ in range(pieces):
        a, b = at(t), at(t + step)
        da, db = d(t), d(t + step)
        pen.curveTo(to_font((a[0] + k * da[0], a[1] + k * da[1])),
                    to_font((b[0] - k * db[0], b[1] - k * db[1])),
                    to_font(b))
        t += step
    if abs(end - start) >= 360:
        pen.closePath()
    else:
        pen.endPath()
    return path


def stroked(path, width=LINE, cap="round", join="round"):
    out = pathops.Path(path)
    out.stroke(width * UNIT,
               {"round": pathops.LineCap.ROUND_CAP,
                "butt": pathops.LineCap.BUTT_CAP,
                "square": pathops.LineCap.SQUARE_CAP}[cap],
               {"round": pathops.LineJoin.ROUND_JOIN,
                "miter": pathops.LineJoin.MITER_JOIN}[join],
               4)
    # Round caps and joins come back as conics, which TrueType cannot hold.
    out.convertConicsToQuads(0.25)
    return out


def dot(x, y, r):
    return arc(x, y, r, r, 0, 360)


def mirror(points):
    """The same points reflected about the glyph's vertical centre line."""
    return [(SIZE - x, y) for x, y in points]


# ── the glyphs ───────────────────────────────────────────────────────────

def hanulso():
    """D480: the 하늘소 ox head -- crescent horns, ears out sideways, a long
    face narrowing to a flat chin, two eyes and the top of the muzzle."""
    # Left half; the right is its mirror.  Each list is one smooth run, and
    # the runs meet at the corners the bitmap draws as corners: the horn
    # tip, the ear tip, and where horn, ear and face meet the head.
    face = [(3.0, 8.15), (3.8, 9.1), (4.45, 10.6), (4.75, 12.0),
            (5.5, 13.5), (6.6, 14.45)]
    ear = [(3.0, 8.15), (1.6, 7.45), (0.5, 6.5)]
    ear_top = [(0.5, 6.5), (2.5, 5.55)]
    horn_out = [(2.5, 5.55), (1.55, 4.6), (1.5, 3.45), (2.3, 2.35), (3.5, 1.4)]
    horn_in = [(3.5, 1.4), (2.6, 2.6), (2.9, 3.85), (4.5, 5.4)]
    brow = [(4.5, 5.4), (5.5, 4.5), (10.5, 4.5), (11.5, 5.4)]
    muzzle = [(6.5, 12.55), (5.7, 12.0), (5.6, 11.1), (6.7, 9.95)]

    def across(run):
        # The run, then its mirror back up the other side, as one curve,
        # so it crosses the centre line level instead of meeting itself
        # there in a point.
        return run + mirror(run)[::-1]

    parts = []
    parts.append(stroked(smooth(across(face))))
    parts.append(stroked(smooth(across(muzzle))))
    for run in (ear, horn_out, horn_in):
        parts.append(stroked(smooth(run)))
        parts.append(stroked(smooth(mirror(run))))
    for run in (ear_top,):
        parts.append(stroked(polyline(run)))
        parts.append(stroked(polyline(mirror(run))))
    parts.append(stroked(polyline(brow)))
    parts.append(dot(5.6, 8.4, 0.62))
    parts.append(dot(10.4, 8.4, 0.62))
    return parts


def carriage_return():
    """D4FA: the boxed return arrow -- a square frame, and an arrow that
    comes down a stem and turns left into a solid, straight-sided head."""
    parts = []
    # The frame's middle line runs through the middle of its pixels.
    parts.append(stroked(polyline([(1.5, 1.5), (14.5, 1.5), (14.5, 14.5),
                                   (1.5, 14.5)], closed=True),
                         join="miter"))
    # Stem (two pixels wide, as drawn) and shaft (one), meeting in a
    # square outer corner.
    parts.append(polyline([(10, 4), (12, 4), (12, 10), (6, 10), (6, 9),
                           (10, 9)], closed=True))
    # The head: the bitmap's stepped wedge as the triangle it stands for.
    parts.append(polyline([(2.9, 9.5), (6.3, 6.6), (6.3, 12.4)], closed=True))
    return parts


def orb():
    """D4FF: a bubble -- a round outline with a crescent of reflected light
    in its upper left, broken where the light is brightest."""
    parts = []
    # Sixteen pixels across and fourteen tall, as on the font's grid.
    parts.append(stroked(arc(8, 8, 7.5, 6.5, 0, 360)))
    # The highlight: thick above the break, thin below it, on one circle.
    parts.append(stroked(arc(8, 8, 4.45, 4.3, -163, -124), width=1.55))
    parts.append(stroked(arc(8, 8, 4.45, 4.3, 125, 160), width=LINE))
    return parts


# ISPC.FNT glyph number (Johab code minus 0xD480): (glyph name, the function
# that returns its parts)
SHAPES = {
    0x00: ("hanulso", hanulso),
    0x7A: ("return", carriage_return),
    0x7F: ("orb", orb),
}


# ── font assembly ────────────────────────────────────────────────────────

def read_unicode():
    path = os.path.join(HERE, "iyagi_user_area.tsv")
    by_index = {}
    with open(path, encoding="utf-8") as fp:
        header = next(fp).rstrip("\n").split("\t")
        col = {name: i for i, name in enumerate(header)}
        for line in fp:
            if not line.strip():
                continue
            row = line.rstrip("\n").split("\t")
            value = row[col["unicode"]].strip()
            if value:
                by_index[int(row[col["ispc_index"]])] = int(value[2:], 16)
    return by_index


def outline(parts):
    """Merge a shape's overlapping parts into one clean outline, as a
    TrueType glyph (quadratic, clockwise outer contours)."""
    # Each part is cleaned up on its own first: a stroke's two sides can
    # wind either way, and added together unsimplified they fill the holes
    # between them.
    for part in parts:
        part.simplify(fix_winding=True, keep_starting_points=False)
    path = pathops.Path()
    pathops.union(parts, path.getPen())
    path.simplify(fix_winding=True, keep_starting_points=False)
    path.reverse()
    tt = TTGlyphPen(None)
    path.draw(Cu2QuPen(tt, max_err=1.0, all_quadratic=True))
    return tt.glyph(), path


def build():
    unicode_of = read_unicode()
    order = [".notdef"] + [name for name, _ in SHAPES.values()]
    glyphs = {".notdef": TTGlyphPen(None).glyph()}
    paths = {}
    cmap = {}
    lsb = {".notdef": 0}
    for index, (name, draw) in SHAPES.items():
        glyphs[name], paths[index] = outline(draw())
        lsb[name] = round(paths[index].bounds[0])
        cmap[unicode_of[index]] = name

    fb = FontBuilder(UPEM, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({name: (UPEM, lsb[name]) for name in order})
    descent = TOP - UPEM
    fb.setupHorizontalHeader(ascent=TOP, descent=descent)
    fb.setupNameTable({
        "familyName": FAMILY,
        "styleName": "Regular",
        "uniqueFontIdentifier": FAMILY.replace(" ", "") + "-Regular",
        "fullName": FAMILY,
        "psName": FAMILY.replace(" ", "") + "-Regular",
        "version": "Version 2.000",
        "description": "Glyphs of Iyagi's ISPC.FNT with no faithful "
                       "Unicode form. Generated by tools/gen_ispc_font.py.",
    })
    fb.setupOS2(sTypoAscender=TOP, sTypoDescender=descent, sTypoLineGap=0,
                usWinAscent=TOP, usWinDescent=-descent,
                sxHeight=0, sCapHeight=0, achVendID="NONE")
    fb.setupPost(isFixedPitch=1)
    # A fixed date, so a rebuild from the same inputs is byte-identical.
    fb.font["head"].created = fb.font["head"].modified = timestampSinceEpoch(0)
    fb.font.flavor = "woff2"

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    fb.save(OUT)
    return cmap, paths


# ── proof sheet ──────────────────────────────────────────────────────────

def proof(paths, out, scale=32):
    """Each outline in translucent ink over its bitmap from docs/ISPC.png,
    then the same outline alone at a few text sizes."""
    from PIL import Image, ImageDraw
    from fontTools.pens.freetypePen import FreeTypePen

    # docs/ISPC.png: a 16x8 table of 65-pixel cells (one grid line plus 16
    # font pixels of 4x4) whose first cell's interior starts at (47, 25).
    dump = Image.open(os.path.join(ROOT, "docs", "ISPC.png")).convert("L")

    def lit(index, gx, gy):
        x = 47 + 65 * (index % 16) + gx * 4 + 2
        y = 25 + 65 * (index // 16) + gy * 4 + 2
        return dump.getpixel((x, y)) < 128

    def render(path, px):
        pen = FreeTypePen(None)
        path.draw(pen)
        k = px / UPEM
        img = pen.image(width=px, height=px,
                        transform=(k, 0, 0, k, 0, (UPEM - TOP) * k))
        return img.getchannel("A")

    big = SIZE * scale
    sizes = (16, 24, 48)
    sheet = Image.new("RGB", (len(paths) * (big + 20) + 20,
                              big + 40 + max(sizes) + 20), "white")
    for i, (index, path) in enumerate(sorted(paths.items())):
        x0 = 20 + i * (big + 20)
        draw = ImageDraw.Draw(sheet)
        for gy in range(SIZE):
            for gx in range(SIZE):
                box = (x0 + gx * scale, 20 + gy * scale,
                       x0 + (gx + 1) * scale - 1, 20 + (gy + 1) * scale - 1)
                draw.rectangle(box, fill=(150, 200, 255) if lit(index, gx, gy)
                               else (245, 245, 245))
        ink = render(path, big)
        sheet.paste(Image.new("RGB", ink.size, (20, 20, 20)), (x0, 20),
                    ink.point(lambda a: a * 160 // 255))
        x = x0
        for px in sizes:
            ink = render(path, px)
            sheet.paste(Image.new("RGB", ink.size, "black"),
                        (x, big + 40), ink)
            x += px + 16
    sheet.save(out)


if __name__ == "__main__":
    cmap, paths = build()
    print("%s: %d glyphs (%s), %d bytes"
          % (os.path.relpath(OUT, ROOT), len(cmap),
             ", ".join("U+%04X" % cp for cp in sorted(cmap)),
             os.path.getsize(OUT)))
    if "--proof" in sys.argv:
        dest = sys.argv[sys.argv.index("--proof") + 1]
        proof(paths, dest)
        print("proof: %s" % dest)
