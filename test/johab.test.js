// Cross-checks src/johab2unicode.js against the Python implementation's
// oracle results and against known corpus strings.
import test from "node:test";
import assert from "node:assert/strict";
import { decodeJohab, johabCharFromCode } from "../src/johab2unicode.js";

const hex = (s) => Uint8Array.from(s.replace(/\s+/g, "").match(/../g).map((h) => parseInt(h, 16)));

test("decodes an IMS title", () => {
  assert.equal(decodeJohab(hex("88f1b7652089a1b4b7b7a12091419da1")), "검은 고양이 네로");
});

test("decodes standalone jamo through the fill codes", () => {
  assert.equal(johabCharFromCode(0x8841), "ㄱ");
  assert.equal(johabCharFromCode(0x8444), "ㄳ");
  assert.equal(johabCharFromCode(0x8441), "　");
});

test("decodes the symbol and hanja area", () => {
  assert.equal(johabCharFromCode(0xd931), "　");
  assert.equal(johabCharFromCode(0xe031), "伽");
  assert.equal(johabCharFromCode(0xf9fe), "詰");
  assert.equal(johabCharFromCode(0xdda4), "い");
});

test("decodes Iyagi's own font glyphs", () => {
  // The trail byte is the glyph number in ISPC.FNT, whose repertoire is
  // CP437's: 0xDC is the lower half block, 0x90 the right-pointing pointer.
  assert.equal(johabCharFromCode(0xd4dc), "▄");
  assert.equal(johabCharFromCode(0xd490), "►");
  assert.equal(decodeJohab(hex("d4dc")), "▄");
  // Two of the glyphs have no BMP equivalent: the 하늘소 ox and the bubble.
  assert.equal(johabCharFromCode(0xd480), "🐂");
  assert.equal([...decodeJohab(hex("d480d4ff"))].join(" "), "🐂 🫧");
  // A caller that would rather keep the codes distinguishable still can.
  assert.equal(decodeJohab(hex("d4dc"), { userGlyph: () => "*" }), "*");
});

test("leaves the rest of the user area unassigned", () => {
  assert.equal(johabCharFromCode(0xd47f), null);
  assert.equal(johabCharFromCode(0xd500), null);
  assert.equal(johabCharFromCode(0xd8ff), null);
  assert.equal(decodeJohab(hex("d500")), "�");
});

test("stops at NUL and passes ASCII through", () => {
  assert.equal(decodeJohab(hex("54757262 6f00 41")), "Turbo");
  assert.equal(decodeJohab(hex("54757262 6f00 41"), { stopAtNul: false }), "Turbo\0A");
});
