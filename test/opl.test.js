// The chip is checked against first principles rather than against another
// emulator: frequencies against the F-number formula, attenuation against the
// documented dB-per-step, envelope timing against the documented doubling law.
import test from "node:test";
import assert from "node:assert/strict";
import { OPL2 } from "../src/opl/chip.js";
import {
  NATIVE_RATE, EG_ATTACK, EG_OFF,
  METER_VOICES, METER_STRIDE, METER_BD, METER_SD, METER_TOM, METER_TC, METER_HH,
  M_PEAK, M_MOD_DB, M_NOTE, M_KEY_ON, CF_RHYTHM,
} from "../src/opl/constants.js";
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

// ── Envelope timing, against the application manual's own table ────────────
//
// Table 3-6 "Attack and Decay Times for Various Rates" states RATE = RM*4 + RL
// where RM is the key-scaled rate's top four bits and RL its bottom two, and
// gives a time in milliseconds for every one of the 64 rates, measured over
// the full 0 dB - 96 dB range. Those milliseconds are for a 3.84 MHz master
// clock; an AdLib card runs 3.579545 MHz, so the times scale by 3.84/3.579545.
//
// This is the only absolute anchor the envelope has. The doubling law alone is
// scale-free, so it passes just as happily with the whole envelope clock off
// by a factor of four -- which is exactly what it was.
const CLOCK = 3.84 / 3.579545;
const TABLE_3_6 = [
  // RM, RL, attack ms, decay ms
  [14, 3, 0.20, 2.74], [14, 0, 0.38, 4.80],
  [13, 3, 0.42, 5.48], [13, 0, 0.70, 9.60],
  [12, 3, 0.80, 10.96], [12, 0, 1.40, 19.20],
  [10, 3, 3.12, 43.84], [10, 0, 5.52, 76.72],
  [8, 3, 12.48, 175.36], [8, 0, 22.08, 306.88],
  [6, 3, 49.92, 701.44], [6, 0, 88.32, 1227.52],
];

// KSR is off, so the key-scale offset is the key scale number's top two bits,
// which for F-number 0 is just block >> 1: blocks 0, 2, 4, 6 give RL 0...3.
const BLOCK_FOR_RL = [0, 2, 4, 6];

/** One carrier, sustaining, sustain level 0, so the envelope idles at full. */
function envelopeRig(block, { ar, rr }) {
  const chip = new OPL2();
  chip.write(0x01, 0x20);
  chip.write(0x20, 0x01);
  chip.write(0x23, 0x21);                        // EG type sustaining, MULT 1
  chip.write(0x40, 0x3f); chip.write(0x43, 0x00);
  chip.write(0x60, 0x00); chip.write(0x63, (ar << 4) | 15);
  chip.write(0x80, 0x00); chip.write(0x83, rr);
  chip.write(0xc0, 0x00);
  chip.write(0xa0, 0x00); chip.write(0xb0, 0x20 | (block << 2));
  return chip;
}

const oneSample = new Float32Array(1);

/** Milliseconds from key-on until the attack phase ends. */
function attackMs(rm, rl) {
  const chip = envelopeRig(BLOCK_FOR_RL[rl], { ar: rm, rr: 0 });
  const op = chip.channels[0].car;
  for (let n = 1; n <= 4e6; n++) {
    chip.generate(oneSample, 0, 1);
    if (op.state !== EG_ATTACK) return (n * 1000) / NATIVE_RATE;
  }
  return Infinity;
}

/** Milliseconds from key-off until the envelope is fully attenuated. */
function releaseMs(rm, rl) {
  const block = BLOCK_FOR_RL[rl];
  const chip = envelopeRig(block, { ar: 15, rr: rm });
  const op = chip.channels[0].car;
  while (op.state === EG_ATTACK) chip.generate(oneSample, 0, 1);
  chip.write(0xb0, block << 2);                  // key off
  for (let n = 1; n <= 4e6; n++) {
    chip.generate(oneSample, 0, 1);
    if (op.state === EG_OFF) return (n * 1000) / NATIVE_RATE;
  }
  return Infinity;
}

test("decay and release times match Table 3-6", () => {
  for (const [rm, rl, , decay] of TABLE_3_6) {
    const want = decay * CLOCK;
    const got = releaseMs(rm, rl);
    assert.ok(Math.abs(got - want) / want < 0.02,
      `RM ${rm} RL ${rl}: want ${want.toFixed(2)} ms, got ${got.toFixed(2)} ms`);
  }
});

test("attack times match Table 3-6", () => {
  // Looser than the decay: the attack closes a fixed fraction of what is left
  // each step, so its length is a step COUNT (36 of them) rather than a clean
  // multiple, and it lands about 6% under the manual throughout. Above rate 56
  // the manual is quoting hundredths of a millisecond, so a tenth of one is
  // allowed to stand in for the percentage there.
  for (const [rm, rl, attack] of TABLE_3_6) {
    const want = attack * CLOCK;
    const got = attackMs(rm, rl);
    const off = Math.abs(got - want);
    assert.ok(off / want < 0.12 || off < 0.1,
      `RM ${rm} RL ${rl}: want ${want.toFixed(2)} ms, got ${got.toFixed(2)} ms`);
  }
});

test("the maximum rate saturates: RM 15 ignores RL", () => {
  // All four of the manual's RM 15 entries read the same 2.40 ms.
  const want = 2.40 * CLOCK;
  for (let rl = 0; rl < 4; rl++) {
    const got = releaseMs(15, rl);
    assert.ok(Math.abs(got - want) / want < 0.02,
      `RM 15 RL ${rl}: want ${want.toFixed(2)} ms, got ${got.toFixed(2)} ms`);
  }
});

test("an attack rate of 15 is effectively instant", () => {
  // The manual prints 0.00 ms for every rate from 60 up.
  assert.ok(attackMs(15, 0) < 0.25, `${attackMs(15, 0).toFixed(3)} ms`);
});

// ── Rhythm mode ───────────────────────────────────────────────────────────

const RHYTHM = { BD: 0x10, SD: 0x08, TOM: 0x04, TC: 0x02, HH: 0x01 };

/** Rhythm mode with every drum's operators at full level and a fast attack. */
function rhythmRig() {
  const chip = new OPL2();
  chip.write(0x01, 0x20);
  for (const off of [16, 17, 18, 19, 20, 21]) {
    chip.write(0x20 + off, 0x01);
    chip.write(0x40 + off, 0x00);
    chip.write(0x60 + off, 0xf8);
    chip.write(0x80 + off, 0x08);
    chip.write(0xe0 + off, 0x00);
  }
  chip.write(0xc0 + 6, 0x00);
  chip.write(0xa6, 0x40); chip.write(0xb6, 2 << 2);          // bass drum, low
  chip.write(0xa7, 0x00); chip.write(0xb7, (5 << 2) | 2);    // hi-hat/snare
  chip.write(0xa8, 0x00); chip.write(0xb8, (3 << 2) | 2);    // tom/cymbal
  chip.write(0xbd, 0x20);
  return chip;
}

/** Peak amplitude and spectral flatness of one drum struck alone. */
function strike(name, samples = 4096) {
  const chip = rhythmRig();
  chip.write(0xbd, 0x20 | RHYTHM[name]);
  const buf = new Float32Array(samples);
  chip.generate(buf, 0, samples);
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));

  const N = 512;
  let sumLog = 0, sumLin = 0, bins = 0;
  for (let k = 1; k < N / 2; k++) {
    let re = 0, im = 0;
    for (let t = 0; t < N; t++) {
      const a = (-2 * Math.PI * k * t) / N;
      re += buf[t] * Math.cos(a); im += buf[t] * Math.sin(a);
    }
    const m = Math.hypot(re, im) / N;
    if (m > 0) { sumLog += Math.log(m); sumLin += m; bins++; }
  }
  // Geometric over arithmetic mean: 1 is white noise, near 0 is a pure tone.
  return { peak, flatness: Math.exp(sumLog / bins) / (sumLin / bins) };
}

test("every rhythm voice actually sounds", () => {
  // The snare used to be silent in all of them: its phase was derived from the
  // wrong bit and only ever landed on the sine's two zero crossings.
  for (const name of Object.keys(RHYTHM)) {
    assert.ok(strike(name).peak > 0.05, `${name} was inaudible`);
  }
});

test("the metallic drums are broadband and the pitched ones are not", () => {
  const flat = Object.fromEntries(
    Object.keys(RHYTHM).map((n) => [n, strike(n).flatness]));
  assert.ok(flat.TOM < 0.15, `tom-tom should be a plain sine: ${flat.TOM}`);
  assert.ok(flat.BD < 0.35, `bass drum should be tonal: ${flat.BD}`);
  assert.ok(flat.HH > 0.5, `hi-hat should be noisy: ${flat.HH}`);
  assert.ok(flat.SD > 0.5, `snare should be noisy: ${flat.SD}`);
  assert.ok(flat.TC > 0.25 && flat.TC < 0.7, `cymbal should be metallic: ${flat.TC}`);
});

test("the hi-hat and cymbal are inharmonic, not the channel's own pitch", () => {
  // Their phase comes from single bits of two accumulators, so retuning the
  // channel must not simply transpose them.
  const pitched = (name, block) => {
    const chip = rhythmRig();
    chip.write(0xb7, (block << 2) | 2);
    chip.write(0xb8, (block << 2) | 2);
    chip.write(0xbd, 0x20 | RHYTHM[name]);
    const buf = new Float32Array(2048);
    chip.generate(buf, 0, buf.length);
    let crossings = 0;
    for (let i = 1; i < buf.length; i++) if (buf[i - 1] <= 0 && buf[i] > 0) crossings++;
    return crossings;
  };
  for (const name of ["HH", "TC"]) {
    const low = pitched(name, 2), high = pitched(name, 5);
    assert.ok(high / low < 4, `${name} transposed like a pitched voice: ${low} -> ${high}`);
  }
  // The tom, by contrast, is a pitched voice and must transpose.
  const tomLow = pitched("TOM", 2), tomHigh = pitched("TOM", 5);
  assert.ok(tomHigh / tomLow > 4, `tom-tom did not transpose: ${tomLow} -> ${tomHigh}`);
});

// ── the meters ────────────────────────────────────────────────────────────
// They are a display's only window onto the chip, so they have to say what the
// chip is really doing rather than what it was last told.

const meters = (chip) => chip.readMeters(new Float32Array(METER_VOICES * METER_STRIDE));
const row = (m, voice, field) => m[voice * METER_STRIDE + field];

test("a metered note is the frequency the channel is actually playing", () => {
  // 580/4 is 440.00 Hz by the F-number formula, so it must read back as A4.
  for (const [fnum, block, midi] of [[580, 4, 69], [290, 4, 57], [580, 5, 81]]) {
    const chip = new OPL2();
    tone(chip, fnum, block);
    const m = meters(chip);
    assert.ok(Math.abs(row(m, 0, M_NOTE) - midi) < 0.05,
      `fnum ${fnum} block ${block}: ${row(m, 0, M_NOTE)} should be ${midi}`);
    assert.equal(row(m, 0, M_KEY_ON), 1);
  }
  // A channel that has never been given an F-number has no note to report.
  assert.equal(row(meters(new OPL2()), 0, M_NOTE), -1);
});

test("the peak is per voice, and reading it clears it", () => {
  const chip = new OPL2();
  tone(chip, 690, 4);
  chip.generate(new Float32Array(2048), 0, 2048);
  const first = meters(chip);
  assert.ok(row(first, 0, M_PEAK) > 0.1, `channel 0 was silent: ${row(first, 0, M_PEAK)}`);
  for (let v = 1; v < METER_VOICES; v++) {
    assert.equal(row(first, v, M_PEAK), 0, `channel ${v} should be silent`);
  }
  // Nothing has been rendered since, so there is no new peak to report.
  assert.equal(row(meters(chip), 0, M_PEAK), 0);
});

test("total level shows up in the metered modulator depth", () => {
  const chip = new OPL2();
  tone(chip, 690, 4);
  chip.write(0xc0, 0x00);                      // modulator on slot 0
  chip.write(0x40, 0);                         // wide open
  chip.generate(new Float32Array(64), 0, 64);
  const open = row(meters(chip), 0, M_MOD_DB);
  chip.write(0x40, 20);                        // 20 steps of 0.75 dB
  chip.generate(new Float32Array(64), 0, 64);
  const shut = row(meters(chip), 0, M_MOD_DB);
  assert.ok(Math.abs(shut - open - 15) < 0.5, `${open} -> ${shut} is not 15 dB`);
});

test("each rhythm instrument meters on its own row", () => {
  const rows = { BD: METER_BD, SD: METER_SD, TOM: METER_TOM, TC: METER_TC, HH: METER_HH };
  for (const [name, mask] of Object.entries(RHYTHM)) {
    const chip = rhythmRig();
    chip.write(0xbd, 0x20 | mask);
    chip.generate(new Float32Array(4096), 0, 4096);
    const m = meters(chip);
    assert.ok(chip.chipFlags & CF_RHYTHM);
    assert.ok(row(m, rows[name], M_PEAK) > 0.05, `${name} did not meter`);
    for (const [other, r] of Object.entries(rows)) {
      if (other !== name) assert.equal(row(m, r, M_PEAK), 0, `${name} leaked into ${other}`);
    }
    // Only the two drums with a channel of their own carry a pitch; §6.
    const tonal = name === "BD" || name === "TOM";
    assert.equal(row(m, rows[name], M_NOTE) >= 0, tonal, `${name} pitch`);
  }
});
