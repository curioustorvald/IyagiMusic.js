// The chip is checked against first principles rather than against another
// emulator: frequencies against the F-number formula, attenuation against the
// documented dB-per-step, envelope timing against the documented doubling law.
import test from "node:test";
import assert from "node:assert/strict";
import { OPL2 } from "../src/opl/chip.js";
import { NATIVE_RATE } from "../src/opl/constants.js";
import { LOG_SIN, EXP, expand, KSL_ROM, MULTIPLE_X2 } from "../src/opl/tables.js";

/** A single sine carrier on channel 0, keyed on, at the given fnum/block. */
function tone(chip, fnum, block, { tl = 0, dr = 0, ar = 15, sl = 0, rr = 0 } = {}) {
  chip.write(0x01, 0x20);
  chip.write(0x20, 0x01); chip.write(0x23, 0x01);
  chip.write(0x40, 0x3f); chip.write(0x43, tl);
  chip.write(0x60, 0xf0); chip.write(0x63, (ar << 4) | dr);
  chip.write(0x80, 0x00); chip.write(0x83, (sl << 4) | rr);
  chip.write(0xc0, 0x00);                                   // additive, no feedback
  chip.write(0xa0, fnum & 0xff);
  chip.write(0xb0, 0x20 | (block << 2) | ((fnum >> 8) & 3));
}

const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

test("log-sin and exp tables have their documented shape", () => {
  assert.equal(LOG_SIN[255], 0);                 // the peak of the quarter sine
  assert.equal(LOG_SIN[0], 2137);                // and its zero crossing
  assert.equal(EXP[0], 0);
  assert.equal(expand(256) / expand(0), 0.5);    // 256 log units is one octave
  assert.equal(KSL_ROM.length, 16);
  assert.equal(MULTIPLE_X2[0], 1);               // multiple 0 is x0.5
  assert.equal(MULTIPLE_X2[15], 30);
});

test("output frequency matches the F-number formula", () => {
  for (const [fnum, block] of [[690, 3], [690, 1], [1023, 7], [345, 4], [100, 2]]) {
    const chip = new OPL2();
    tone(chip, fnum, block);
    const n = 1 << 17;
    const buf = new Float32Array(n);
    chip.generate(buf, 0, n);
    let first = -1, last = -1, count = 0, prev = buf[0];
    for (let i = 1; i < n; i++) {
      if (prev <= 0 && buf[i] > 0) { if (first < 0) first = i; last = i; count++; }
      prev = buf[i];
    }
    const measured = ((count - 1) * NATIVE_RATE) / (last - first);
    const expected = (fnum * NATIVE_RATE) / 2 ** (20 - block);
    assert.ok(Math.abs(measured - expected) / expected < 1e-3,
      `fnum ${fnum} block ${block}: got ${measured}, want ${expected}`);
  }
});

test("total level attenuates by 0.75 dB a step", () => {
  const level = (tl) => {
    const chip = new OPL2();
    tone(chip, 690, 3, { tl });
    const buf = new Float32Array(1 << 14);
    chip.generate(buf, 0, buf.length);
    return rms(buf);
  };
  const ref = level(0);
  for (const tl of [1, 4, 8, 16, 32]) {
    const db = -20 * Math.log10(level(tl) / ref);
    assert.ok(Math.abs(db - tl * 0.75) < 0.15, `TL ${tl}: ${db.toFixed(3)} dB`);
  }
});

test("decay time halves for every step of the decay rate", () => {
  // Envelope peak per 64-sample window; time until it falls 6 dB.
  const decaySamples = (dr) => {
    const chip = new OPL2();
    tone(chip, 690, 3, { dr, sl: 15 });
    const win = new Float32Array(64);
    let ref = 0;
    for (let blk = 0; blk < 200000; blk++) {
      chip.generate(win, 0, win.length);
      let peak = 0;
      for (const v of win) peak = Math.max(peak, Math.abs(v));
      if (blk === 1) ref = peak;
      else if (blk > 1 && peak < ref * 0.5) return blk * win.length;
    }
    return null;
  };
  let prev = null;
  for (const dr of [4, 5, 6, 7, 8]) {
    const t = decaySamples(dr);
    assert.ok(t !== null, `DR ${dr} never decayed`);
    if (prev !== null) {
      const ratio = prev / t;
      assert.ok(Math.abs(ratio - 2) < 0.25, `DR ${dr}: ratio to previous was ${ratio}`);
    }
    prev = t;
  }
});

test("a rate of zero means never, not slow", () => {
  const chip = new OPL2();
  tone(chip, 690, 3, { dr: 0, sl: 8 });
  const buf = new Float32Array(1 << 16);
  chip.generate(buf, 0, buf.length);
  const head = rms(buf.subarray(0, 4096));
  const tail = rms(buf.subarray(buf.length - 4096));
  assert.ok(Math.abs(20 * Math.log10(tail / head)) < 0.5, "DR 0 should hold its level");
});

test("operator registers address all eighteen operators", () => {
  // Offsets run to 0x15, so masking with 0x0f would alias the third bank of
  // operators onto the first -- which silences whole songs.
  const chip = new OPL2();
  for (const off of [0x00, 0x05, 0x08, 0x0d, 0x10, 0x15]) {
    chip.write(0x40 + off, 0x2a);
  }
  const levels = chip.operators.map((o) => o.totalLevel);
  assert.equal(levels.filter((v) => v === 0x2a).length, 6);
});
