// johab2unicode -- KS C 5601-1992 Johab (2-byte Korean) to Unicode.
//
// Covers the encoding as it is actually used by Iyagi music files: ASCII
// passthrough, the bit-packed Hangul syllable area, the symbol/hanja area,
// and Iyagi's user-defined glyph area.  See docs/JOHAB_ENCODING.en.md.
//
// The user-defined glyphs are Iyagi's own font rather than any standard, so
// their Unicode equivalents are a judgement about what each glyph *is* -- see
// tools/iyagi_user_area.tsv, which records the font it came out of alongside
// each decision.

import { JOHAB_SYMBOL_TABLE } from "./johab-symbols.js";
import { USER_GLYPH_FIRST, USER_GLYPH_TABLE } from "./user-glyphs.js";

// Bit-field slot numbers, 0 where the slot is unassigned.  Index by the
// 5-bit field value; the payload is the jamo's index in the Unicode
// composition formula (+1, so that 0 can mean "unassigned").
const CHO = new Int8Array(32);
const JUNG = new Int8Array(32);
const JONG = new Int8Array(32);
for (let i = 0; i < 19; i++) CHO[2 + i] = i + 1;
[3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15, 18, 19, 20, 21, 22, 23, 26, 27, 28, 29]
  .forEach((slot, i) => { JUNG[slot] = i + 1; });
// Slot 1 is "no final"; 18 is unassigned.  Everything else counts up.
JONG[1] = 1;
[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19, 20, 21, 22, 23,
  24, 25, 26, 27, 28, 29].forEach((slot, i) => { JONG[slot] = i + 2; });

// Standalone jamo, reachable through the fill codes.
const CHO_COMPAT = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃ" +
  "ㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const JUNG_COMPAT = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗ" +
  "ㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
const JONG_COMPAT = "ㄱㄲㄳㄴㄵㄶㄷㄹㄺ" +
  "ㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇ" +
  "ㅈㅊㅋㅌㅍㅎ";

/** Lowest and highest code of Iyagi's user-defined glyph area. */
export const USER_AREA_FIRST = 0xd400;
export const USER_AREA_LAST = 0xd8ff;

/**
 * Decode a single 2-byte Johab code.
 * @param {number} code 16-bit big-endian code (lead << 8 | trail)
 * @returns {string|null} the character, or null if the code is not assigned
 */
export function johabCharFromCode(code) {
  const lead = code >> 8;
  if (lead >= 0x84 && lead <= 0xd3) {
    const cho = CHO[(code >> 10) & 0x1f];
    const jung = JUNG[(code >> 5) & 0x1f];
    const jong = JONG[code & 0x1f];
    if (cho && jung && jong) {
      return String.fromCharCode(0xac00 + (cho - 1) * 588 + (jung - 1) * 28 + (jong - 1));
    }
    // Fill codes: exactly one of the three parts carries a real jamo.
    const choFill = ((code >> 10) & 0x1f) === 1;
    const jungFill = ((code >> 5) & 0x1f) === 2;
    if (choFill && jungFill && jong === 1) return "\u3000"; // all three fills
    if (cho && jungFill && jong === 1) return CHO_COMPAT[cho - 1];
    if (choFill && jung && jong === 1) return JUNG_COMPAT[jung - 1];
    if (choFill && jungFill && jong > 1) return JONG_COMPAT[jong - 2];
    return null;
  }
  // Iyagi's own glyphs, which are the ISPC.FNT graphics font addressed by the
  // trail byte.  Only the one lead byte is populated; the rest of the user
  // area is unassigned, here and in the corpus.  See JOHAB_ENCODING section 5.
  const glyphIndex = code - USER_GLYPH_FIRST;
  if (glyphIndex >= 0 && glyphIndex < USER_GLYPH_TABLE.length) {
    const glyph = USER_GLYPH_TABLE[glyphIndex];
    return glyph ? String.fromCodePoint(glyph) : null;
  }
  let leadIndex = -1;
  if (lead >= 0xd9 && lead <= 0xde) leadIndex = lead - 0xd9;
  else if (lead >= 0xe0 && lead <= 0xf9) leadIndex = lead - 0xe0 + 6;
  if (leadIndex < 0) return null;
  const trail = code & 0xff;
  let trailIndex;
  if (trail >= 0x31 && trail <= 0x7e) trailIndex = trail - 0x31;
  else if (trail >= 0x91 && trail <= 0xfe) trailIndex = trail - 0x43;
  else return null;
  const cp = JOHAB_SYMBOL_TABLE.charCodeAt(leadIndex * 188 + trailIndex);
  return cp ? String.fromCharCode(cp) : null;
}

/**
 * Decode a Johab byte string.
 *
 * @param {Uint8Array|number[]} bytes
 * @param {object} [options]
 * @param {string} [options.replacement="�"] stand-in for undecodable codes
 * @param {(code:number)=>(string|null)} [options.userGlyph] called for codes in
 *   the user-defined area (0xD400-0xD8FF) ahead of the built-in mapping, for
 *   callers that would rather keep those codes distinguishable than read them
 * @param {boolean} [options.stopAtNul=true] stop at the first 0x00
 * @returns {string}
 */
export function decodeJohab(bytes, options = {}) {
  const {
    replacement = "�",
    userGlyph = null,
    stopAtNul = true,
  } = options;
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x00 && stopAtNul) break;
    if (b < 0x80) { out.push(String.fromCharCode(b)); continue; }
    if (i + 1 >= bytes.length) { out.push(replacement); break; }
    const code = (b << 8) | bytes[++i];
    if (userGlyph && code >= USER_AREA_FIRST && code <= USER_AREA_LAST) {
      const g = userGlyph(code);
      if (g !== null && g !== undefined) { out.push(g); continue; }
    }
    out.push(johabCharFromCode(code) ?? replacement);
  }
  return out.join("");
}

/** Trim the trailing NULs and spaces of a fixed-width text field, then decode. */
export function decodeJohabField(bytes, options) {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0x00 || bytes[end - 1] === 0x20)) end--;
  return decodeJohab(bytes.subarray ? bytes.subarray(0, end) : bytes.slice(0, end), options);
}
