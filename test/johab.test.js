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

test("rejects the user-defined glyph area", () => {
  assert.equal(johabCharFromCode(0xd4dc), null);
  assert.equal(decodeJohab(hex("d4dc")), "�");
  assert.equal(decodeJohab(hex("d4dc"), { userGlyph: () => "*" }), "*");
});

test("stops at NUL and passes ASCII through", () => {
  assert.equal(decodeJohab(hex("54757262 6f00 41")), "Turbo");
  assert.equal(decodeJohab(hex("54757262 6f00 41"), { stopAtNul: false }), "Turbo\0A");
});
