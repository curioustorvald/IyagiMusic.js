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

There is no mapping for these — the glyphs only exist in Iyagi's font. A
decoder should hand them to the caller rather than guess. `decodeJohab()`
takes a `userGlyph` callback for exactly this, so that a player which does
have the font (or a plausible Unicode stand-in for each glyph) can supply one,
and everything else gets U+FFFD.

Outside that area the corpus holds 24 more undecodable codes, 84 occurrences
in total: unassigned jamo combinations in the Hangul range, unassigned KS X
1001 cells, and five with a trail byte in the structural gap 0x7F-0x90. They
are encoder slips in individual files, not a second glyph area — two song
titles carry one apiece, in the middle of otherwise clean Japanese text.

## 6. Implementations

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
