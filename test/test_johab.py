#!/usr/bin/env python3
"""Oracle test for tools/johab2unicode.py.

Checks every 2-byte code against CPython's built-in ``johab`` codec, then
checks that the JavaScript twin agrees with the Python one over the same
space.  Run with:  python3 test/test_johab.py
"""
import json
import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

from johab2unicode import decode_johab, johab_char_from_code  # noqa: E402
from user_glyphs import USER_GLYPH_FIRST, USER_GLYPH_TABLE  # noqa: E402


class TestJohab(unittest.TestCase):
    def test_matches_cpython_codec(self):
        bad = []
        for code in range(0x8000, 0x10000):
            raw = code.to_bytes(2, "big")
            try:
                want = raw.decode("johab")
            except UnicodeDecodeError:
                want = None
            got = johab_char_from_code(code)
            if USER_GLYPH_FIRST <= code < USER_GLYPH_FIRST + len(USER_GLYPH_TABLE):
                # Iyagi's own font glyphs.  The codec cannot know these -- they
                # are not in the standard at all -- and we map them anyway, so
                # the oracle's silence here is the expected answer.
                self.assertIsNone(want, hex(code))
                self.assertIsNotNone(got, hex(code))
                continue
            if want != got:
                bad.append((hex(code), want, got))
        self.assertEqual(bad, [])

    def test_known_strings(self):
        self.assertEqual(
            decode_johab(bytes.fromhex("88f1b7652089a1b4b7b7a12091419da1")),
            "검은 고양이 네로")
        self.assertEqual(johab_char_from_code(0x8841), "ㄱ")
        self.assertEqual(johab_char_from_code(0x8441), "　")
        self.assertEqual(johab_char_from_code(0xD4DC), "▄")
        self.assertEqual(johab_char_from_code(0xD480), "\U0001F402")
        self.assertIsNone(johab_char_from_code(0xD500))

    def test_javascript_twin_agrees(self):
        script = """
import { johabCharFromCode } from "../src/johab2unicode.js";
const out = [];
for (let c = 0x8000; c < 0x10000; c++) {
  const ch = johabCharFromCode(c);
  if (ch !== null) out.push(c, ch.codePointAt(0));
}
process.stdout.write(JSON.stringify(out));
"""
        path = os.path.join(ROOT, "test", ".jstwin.mjs")
        with open(path, "w", encoding="utf-8") as fp:
            fp.write(script)
        try:
            res = subprocess.run([_node(), path], capture_output=True,
                                 check=True, cwd=os.path.join(ROOT, "test"))
        finally:
            os.unlink(path)
        flat = json.loads(res.stdout)
        js = {flat[i]: chr(flat[i + 1]) for i in range(0, len(flat), 2)}
        py = {c: ch for c in range(0x8000, 0x10000)
              if (ch := johab_char_from_code(c)) is not None}
        self.assertEqual(js, py)


def _node():
    for name in ("node", "nodejs"):
        try:
            subprocess.run([name, "--version"], capture_output=True, check=True)
            return name
        except (OSError, subprocess.CalledProcessError):
            continue
    raise unittest.SkipTest("node not available")


if __name__ == "__main__":
    unittest.main()
