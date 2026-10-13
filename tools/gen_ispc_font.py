#!/usr/bin/env python3
"""Build a webfont of the ISPC.FNT glyphs that Unicode has no faithful form for.

Most of Iyagi's user-defined glyphs are CP437's, and any font draws them
well enough.  Three are Iyagi's own, and the code points
``tools/iyagi_user_area.tsv`` gives them are the nearest Unicode has rather
than the glyph itself -- a browser draws an emoji ox for the Hanulso logo, a
tiny "NL" for the boxed return arrow, and emoji soap bubbles for the orb.
This font carries the original 16x16 bitmaps at those same code points, so a
page that puts it ahead of its text fonts (with ``unicode-range`` limiting it
to those three) shows what the Iyagi screen showed, and the decoded text
stays the same string either way.

Source of the bitmaps: ``docs/ISPC.png``, the dump of the whole font, read
back pixel by pixel off its grid.  Source of the code points: the ``unicode``
column of ``tools/iyagi_user_area.tsv``, by glyph number, so the font cannot
drift from what ``src/user-glyphs.js`` decodes to.

Each glyph is one em square, sixteen font pixels across, and the pixels are
merged into a single outline per shape so nothing seams at small sizes.

Needs Pillow, fontTools, brotli and skia-pathops:
    pip install pillow fonttools brotli skia-pathops

Usage:  python3 tools/gen_ispc_font.py          # rewrite fonts/iyagi-ispc.woff2
        python3 tools/gen_ispc_font.py --show   # also print the bitmaps
"""
import os
import sys

from PIL import Image
from fontTools.fontBuilder import FontBuilder
from fontTools.misc.timeTools import timestampSinceEpoch
from fontTools.pens.ttGlyphPen import TTGlyphPen
import pathops

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

FAMILY = "Iyagi ISPC"
OUT = os.path.join(ROOT, "fonts", "iyagi-ispc.woff2")

# ISPC.FNT glyph numbers (Johab code minus 0xD480) to carry.
GLYPHS = {
    0x00: "hanulso",   # D480, the Hanulso ox head
    0x7A: "return",    # D4FA, the boxed return arrow
    0x7F: "orb",       # D4FF, the bubble
}

# docs/ISPC.png: a 16x8 table of 65-pixel cells (one grid line plus 16 font
# pixels of 4x4) whose first cell's interior starts at (47, 25).
GRID_X, GRID_Y, CELL, SCALE, SIZE = 47, 25, 65, 4, 16

# One font pixel is 64 units, so a glyph is exactly one em.  The square sits
# from 880 down to -144, which centres it where Hangul's middle is in the
# fonts the page falls back to.
UNIT = 64
UPEM = SIZE * UNIT
TOP = 880


def read_bitmap(img, index):
    px = img.load()
    x0 = GRID_X + CELL * (index % 16)
    y0 = GRID_Y + CELL * (index // 16)
    rows = []
    for gy in range(SIZE):
        row = []
        for gx in range(SIZE):
            block = [px[x0 + gx * SCALE + i, y0 + gy * SCALE + j]
                     for i in range(SCALE) for j in range(SCALE)]
            mean = sum(block) / len(block)
            # The dump is pure black on white; anything grey means the grid
            # assumptions above are off.
            if 16 < mean < 240:
                raise SystemExit("glyph %#x pixel (%d,%d) is grey (%.0f): "
                                 "ISPC.png grid is not where expected"
                                 % (index, gx, gy, mean))
            row.append(mean < 128)
        rows.append(row)
    return rows


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


def outline(bitmap):
    """Union of the lit pixels, as a TrueType glyph."""
    path = pathops.Path()
    for gy, row in enumerate(bitmap):
        for gx, lit in enumerate(row):
            if not lit:
                continue
            x0, x1 = gx * UNIT, (gx + 1) * UNIT
            y1 = TOP - gy * UNIT
            y0 = y1 - UNIT
            pen = path.getPen()
            pen.moveTo((x0, y0))
            pen.lineTo((x0, y1))
            pen.lineTo((x1, y1))
            pen.lineTo((x1, y0))
            pen.closePath()
    path.simplify(fix_winding=True, keep_starting_points=False)
    # TrueType wants clockwise outer contours; skia hands back the reverse.
    path.reverse()
    tt = TTGlyphPen(None)
    path.draw(tt)
    return tt.glyph()


def build(show=False):
    img = Image.open(os.path.join(ROOT, "docs", "ISPC.png")).convert("L")
    unicode_of = read_unicode()

    order = [".notdef"] + list(GLYPHS.values())
    glyphs = {".notdef": TTGlyphPen(None).glyph()}
    cmap = {}
    lsb = {".notdef": 0}
    for index, name in GLYPHS.items():
        bitmap = read_bitmap(img, index)
        if show:
            print("%s  D4%02X  U+%04X" % (name, 0x80 + index, unicode_of[index]))
            print("\n".join("".join("#" if b else "." for b in r)
                            for r in bitmap))
        glyphs[name] = outline(bitmap)
        lsb[name] = min(gx for row in bitmap
                        for gx, lit in enumerate(row) if lit) * UNIT
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
        "version": "Version 1.000",
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
    return cmap


if __name__ == "__main__":
    cmap = build(show="--show" in sys.argv)
    print("%s: %d glyphs (%s), %d bytes"
          % (os.path.relpath(OUT, ROOT), len(cmap),
             ", ".join("U+%04X" % cp for cp in sorted(cmap)),
             os.path.getsize(OUT)))
