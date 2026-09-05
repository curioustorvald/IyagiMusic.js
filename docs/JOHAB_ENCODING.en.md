# The Korean text encoding of Iyagi music files

Song titles, lyric lines and credits in `.ims` and `.iss` files are **KS C
5601-1992 조합형 (Johab)**, the bit-packed 2-byte Korean encoding that Korean
DOS software used before Windows made 완성형 (Wansung / CP949) universal.

## 1. Getting the name right

Two encodings are easy to confuse here, and the reference material for these
files points at the wrong one.

- **KS C 5601-1992 Johab** — what these files actually use.
- **한/글 (Haansoft) 2-byte code**, sometimes called HNC code — the word
  processor's own encoding.

The two are **identical throughout the Hangul syllable block**, which is why a
Haansoft mapping table decodes song titles perfectly and looks like the right
answer. They diverge above it: Haansoft continues into old-Hangul jamo
clusters, while Johab puts symbols, kana and hanja there. Decode an Iyagi
lyric line with a Haansoft table and roughly one character in twenty comes out
as an archaic jamo cluster where a box-drawing character or a kana belongs.
*(measured on 276 196 two-byte codes across the corpus: 238 775 Hangul
syllables, 15 172 kana, 8 495 other symbols, 792 hanja, 338 standalone jamo.)*

Use Johab.

## 2. Byte structure

A byte below 0x80 is ASCII and stands alone. A byte of 0x84 or above begins a
two-byte code, most significant byte first.

| Lead bytes | Contents |
|------------|----------|
| `0x84`–`0xD3` | Hangul syllables and standalone jamo — §3 |
| `0xD4`–`0xD8` | **unassigned** — Iyagi's user glyphs live here, §5 |
| `0xD9`–`0xDE` | symbols, punctuation, kana, Cyrillic, box drawing — §4 |
| `0xDF`        | unassigned |
| `0xE0`–`0xF9` | hanja — §4 |
| `0xFA`–`0xFF` | unassigned |

## 3. The Hangul area

The 16-bit code is four bit-fields:

```
 15  14        10  9         5  4         0
+---+------------+------------+------------+
| 1 |  초성 (5)  |  중성 (5)  |  종성 (5)  |
+---+------------+------------+------------+
    initial       medial       final
```

Each field is a slot number, and the slot numbering is **not contiguous** —
gaps in the medial and final tables are what let the packing line up with the
jamo's natural groupings.

**Initial (초성), slots 2–20**, in order:

```
ㄱ ㄲ ㄴ ㄷ ㄸ ㄹ ㅁ ㅂ ㅃ ㅅ ㅆ ㅇ ㅈ ㅉ ㅊ ㅋ ㅌ ㅍ ㅎ
```

Slot 1 is the *fill* code (no initial).

**Medial (중성), slots 3–7, 10–15, 18–23, 26–29**, in order:

```
ㅏ ㅐ ㅑ ㅒ ㅓ | ㅔ ㅕ ㅖ ㅗ ㅘ ㅙ | ㅚ ㅛ ㅜ ㅝ ㅞ ㅟ | ㅠ ㅡ ㅢ ㅣ
```

Slot 2 is the fill code. Slots 0, 1, 8, 9, 16, 17, 24, 25, 30, 31 are unused.

**Final (종성), slot 1 = none, slots 2–17 and 19–29**, in order:

```
ㄱ ㄲ ㄳ ㄴ ㄵ ㄶ ㄷ ㄹ ㄺ ㄻ ㄼ ㄽ ㄾ ㄿ ㅀ ㅁ | ㅂ ㅄ ㅅ ㅆ ㅇ ㅈ ㅊ ㅋ ㅌ ㅍ ㅎ
```

Slot 18 is unused; slot 0 does not occur.

With all three fields assigned, the Unicode syllable is the usual composition:

```
U+AC00 + initialIndex * 588 + medialIndex * 28 + finalIndex
```

where the indices are 0-based positions in the lists above and `finalIndex`
is 0 for "no final".

*(measured: this decomposition reproduces all 11 172 modern Hangul syllables
exactly, with no ambiguous slot in any of the three fields.)*

**Fill codes** produce standalone jamo, the compatibility jamo at U+3131 and
up:

- initial + medial-fill + no-final → the initial alone, e.g. `0x8841` = `ㄱ`
- initial-fill + medial + no-final → the medial alone
- initial-fill + medial-fill + final → the final alone, e.g. `0x8444` = `ㄳ`
- all three fill (`0x8441`) → U+3000, the ideographic space

Codes in the Hangul lead-byte range whose fields do not resolve are simply
undefined.

## 4. The symbol and hanja area

Not arithmetic — it needs a table. Both lead-byte ranges flatten into one
dense index:

```
leadIndex  = lead - 0xD9              for 0xD9-0xDE
           = lead - 0xE0 + 6          for 0xE0-0xF9
trailIndex = trail - 0x31             for 0x31-0x7E
           = trail - 0x43             for 0x91-0xFE
index      = leadIndex * 188 + trailIndex
```

That is 32 leads × 188 trails = 6016 slots, of which 5825 are assigned. The
contents are the non-Hangul half of KS X 1001: punctuation, full-width Latin
and Greek, box drawing, both kana syllabaries, Cyrillic, and 4888 hanja.

`tools/gen_johab_table.py` in this repository regenerates that table.

## 5. Iyagi's user-defined glyphs

Codes with lead bytes `0xD4`–`0xD8` are unassigned in Johab, and Iyagi uses
`0xD4xx` for glyphs from its own font — the decorative dingbats that ISS title
screens are built out of. They appear in symmetric pairs bracketing a
line, or interleaved between the characters of a name as separators.

*(measured: 12 624 occurrences over 84 distinct codes, 60 of them under lead
byte `0xD4`; 4.6% of all two-byte codes in the corpus text.)*

The glyphs are `ISPC.FNT`, the graphics font Iyagi ships, and the trail byte
is the glyph number: **`0xD4tt` draws glyph `tt − 0x80`**, so the assigned
codes are `0xD480`–`0xD4FF` and the rest of the area is empty. The repertoire
is IBM CP437's, which is what a BBS terminal wants — the ANSI-art box pieces,
shading blocks and dingbats, re-encoded so that an eight-bit byte which is not
half of a Johab pair still has a two-byte home in the stored text. Twenty of
the 128 slots are Iyagi's own rather than CP437's: the 하늘소 ox at `0xD480`,
sixteen cursive Greek letters and marks at `0xD4A0`–`0xD4AF`, a filled circle,
a boxed ↵ used as a line-continuation mark, and a bubble.

`tools/iyagi_user_area.tsv` holds the mapping — one row per code, with the
CP437 byte, the Unicode equivalent and the corpus count — and
`tools/gen_user_glyphs.py` turns it into the table both implementations read.
Where the font and its addressing came from is written up outside this repo,
in the workspace's `iyagi_for_windows/docs/KSR_FONT.en.md`.

The Unicode equivalents are a judgement about what each glyph *is*, not a
standard, and they are not unique: **69 of the 128 characters are also
reachable through a KS X 1001 symbol code** (♥ is both `0xD483` and `0xD9BE`),
and two codes draw the same letter (ε is both `0xD4A0` and `0xD4EE`). So these
codes can be read, but a round trip through Unicode cannot recover which code
a file held. Anything that has to keep the bytes — an editor, a converter —
should pass `decodeJohab()` a `userGlyph` callback and map the codes somewhere
private of its own, which is what the ISS studio does.

Outside that area the corpus holds 24 more undecodable codes, 84 occurrences
in total: unassigned jamo combinations in the Hangul range, unassigned KS X
1001 cells, and five with a trail byte in the structural gap 0x7F-0x90. They
are encoder slips in individual files, not a second glyph area — two song
titles carry one apiece, in the middle of otherwise clean Japanese text.

## 6. Character cells

On the text screen these files were written for, **a one-byte code occupies one
cell and a two-byte code occupies two**. That is the whole rule, and ISS
highlight records count in exactly those cells (FILE_FORMATS §4.2).

Decoding throws that information away: a Unicode string no longer remembers how
many bytes a character arrived as. It can be recovered from the code point
alone, because the two byte lengths land in disjoint ranges —

```
two cells  ⟺  code point >= U+0080
```

— and that is exact, not a heuristic. No two-byte code decodes to anything
below U+0080, and every one-byte code is ASCII by construction; checked over
all 65 536 two-byte codes and all 128 one-byte codes.

The tempting alternative is Unicode's East Asian Width property, and it is a
different question with a different answer. It describes how a modern font
lays a character out, not how many cells a DOS screen gave it, and it disagrees
on **470 of the 17 065 assigned two-byte codes**. Two groups account for
almost all of them:

- the KS X 1001 symbol rows below U+2E80 — `·` `‥` `…` `―` `※` `☆` `★` `○`
  `■` `◁` `▶` `▒` `♥` `♪` `→`, the box-drawing set, circled and parenthesised
  letters, and the mathematical operators;
- Greek and Cyrillic, which Unicode classes as East Asian *Ambiguous* —
  narrow in a Western context, two cells on the screen that actually drew them.

A decoder's own substitutions inherit the width of the code they replace, not
the width of the character they borrow. U+FFFD, and whatever stand-in a
`userGlyph` callback returns for §5's font glyphs, both replace a two-byte
code and therefore occupy two cells, whatever a font makes of them — the ISS
studio's private-use stand-ins included.

Two of §5's glyphs decode above the BMP, the ox and the bubble. They are one
character from one two-byte code and so are two cells, not four, which is a
statement about walking the string as well: step it by code point, or a
surrogate pair counts twice and an index can land between its halves.

*(measured: over the 696 corpus `.iss` files, counting cells this way agrees
with the files' own byte counts on all 41 849 screen lines. Counting them by
East Asian Width instead disagreed on 6144 lines in 567 files, which put 19 216
highlight records on the wrong characters.)*

## 7. Implementations

- `src/johab2unicode.js` — ES module, no dependencies
- `tools/johab2unicode.py` — Python 3, no dependencies, also usable as a CLI

Both are verified against CPython's built-in `johab` codec over all 32 768
two-byte codes, and against each other, by `test/test_johab.py`. The one place
they knowingly differ from that codec is the user-defined area, which the
codec rejects and these decoders route through the `userGlyph` hook.

Field text is fixed-width and NUL-padded; `decodeJohabField` /
`decode_johab_field` trim trailing NULs and spaces first. A NUL inside a field
ends it — but note that BNK patch names and some ROL timbre names carry
non-NUL junk after their terminator, so trim at the first NUL rather than
stripping NULs out of the middle.
