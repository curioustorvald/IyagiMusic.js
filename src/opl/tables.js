// OPL2 and OPL3 lookup tables. All of them are computed here from their closed
// forms rather than pasted in, so the derivation is the documentation. The two
// the chip really does hold in ROM (log-sin, exp) come out bit-exact; the KSL
// table is stated because three of its sixteen entries round differently from
// the closed form, and the difference is 0.75 dB.
//
// The OPL3 adds no tables. Its four extra waveforms are the same quarter sine
// read differently, and `waveform` below builds them out of LOG_SIN.

import { ENV_MAX } from "./constants.js";

/**
 * Quarter sine, as a base-2 logarithm.
 *
 *     LOG_SIN[i] = round(-log2(sin((i + 0.5) · π / 512)) · 256)
 *
 * The unit is 1/256 of a power of two, which is what EXP undoes. Working in
 * logs is what lets the envelope be an addition instead of a multiply.
 */
export const LOG_SIN = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    t[i] = Math.round(-Math.log2(Math.sin(((i + 0.5) * Math.PI) / 512)) * 256);
  }
  return t;
})();

/**
 * Fractional powers of two, offset so that the table's own leading 1 is
 * implicit:  EXP[i] = round((2^(i / 256) − 1) · 1024).
 */
export const EXP = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) t[i] = Math.round((2 ** (i / 256) - 1) * 1024);
  return t;
})();

/**
 * Total attenuation (in 1/256-log2 units) to a linear amplitude, chip-style.
 *
 * The table plus its implicit leading bit spans 1024…2047, and the operator
 * output carries one more bit below the sign, so full scale is about ±4084.
 * That factor is not cosmetic: the operator's output IS the phase deviation
 * fed to the next operator, so halving it halves the modulation index and the
 * feedback depth, and the patch comes out dull. Feedback 7 is documented as
 * 4π — two whole cycles of a 1024-step phase — which only works out if full
 * scale is 4096.
 */
/** @param {number} att @returns {number} */
export function expand(att) {
  if (att >= 0x1800) return 0;                 // past −96 dB, the chip gives up
  const frac = att & 0xff;
  const whole = att >> 8;
  return ((EXP[255 - frac] + 1024) << 1) >> whole;
}

/**
 * Key scale level: how much an operator is attenuated for playing high.
 *
 * The published ROM is [0, 24, 32, 37, 40, 43, 45, 47, 48, 50, 51, 52, 53, 54,
 * 55, 56] indexed by the top four bits of the 10-bit F-number, in units of
 * 0.75 dB — eight units to the octave, which is the 6 dB/octave that a KSL
 * setting of 3 is documented to give. `round(8·log2(i)) + 24` reproduces it
 * except at i = 7, 9, 14 and 15, where the ROM is one unit higher; the ROM is
 * what is used.
 */
export const KSL_ROM = Object.freeze([
  0, 24, 32, 37, 40, 43, 45, 47, 48, 50, 51, 52, 53, 54, 55, 56,
]);

/**
 * How far to shift the KSL amount down for each setting.
 *
 * Settings 1 and 2 are the wrong way round versus intuition and versus their
 * numeric order — 1 is 3.0 dB/octave and 2 is 1.5 — which is a documented
 * quirk of the chip, not a transcription slip.
 */
export const KSL_SHIFT = Object.freeze([null, 1, 2, 0]);

/** KSL attenuation in 0.75 dB units for a block/F-number, before the setting. */
/** @param {number} block @param {number} fnum @returns {number} */
export function kslAttenuation(block, fnum) {
  const v = KSL_ROM[(fnum >> 6) & 15] - 8 * (7 - block);
  return v > 0 ? v : 0;
}

/**
 * Frequency multiplier, doubled so that the ×0.5 setting stays an integer.
 * Note the repeats: 11 is ×10 again, 13 is ×12 again, 15 is ×15 again.
 */
export const MULTIPLE_X2 = Object.freeze([
  1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30,
]);

/**
 * Sustain level in envelope steps. One setting step is 3 dB — sixteen
 * envelope steps — except that 15 means −93 dB rather than −45.
 */
export const SUSTAIN_LEVEL = (() => {
  const t = new Uint16Array(16);
  for (let i = 0; i < 15; i++) t[i] = i * 16;
  t[15] = 496;
  return t;
})();

/**
 * Envelope rate duty patterns.
 *
 * A rate's top four bits halve the step period for every increment, which is
 * the `1 << (15 − rate)` law the published attack and decay times follow. The
 * bottom two bits interpolate between those octaves by skipping some of the
 * opportunities: four, five, six or seven out of every eight.
 */
export const EG_DUTY = Object.freeze([
  Object.freeze([1, 0, 1, 0, 1, 0, 1, 0]),
  Object.freeze([1, 0, 1, 0, 1, 0, 1, 1]),
  Object.freeze([1, 0, 1, 1, 1, 0, 1, 1]),
  Object.freeze([1, 0, 1, 1, 1, 1, 1, 1]),
]);

/**
 * Waveform lookup: turn a 10-bit phase into a log-domain attenuation and a
 * sign. Returns the attenuation; `outSign[0]` receives −1 or +1, and a
 * silenced quarter returns SILENCE.
 *
 * Shapes 0…3 are the OPL2's, selected by register 0xE0 once 0x01 bit 5 is set.
 * Shapes 4…7 are the OPL3's four additions, which register 0xE0 can only reach
 * once 0x105 bit 0 (NEW) is set. Every one of the eight is the same quarter
 * sine read differently — the chip holds one table, not eight — so they are
 * built here out of LOG_SIN rather than stated.
 *
 * The four new shapes, as the YMF262's published waveform figure draws them:
 *
 *   4  the sine at double rate, and silence through the second half
 *   5  the same, rectified: two humps and then silence
 *   6  a square wave — no attenuation at all, just the sine's sign
 *   7  a logarithmic sawtooth: a straight line in the *attenuation* domain,
 *      0 dB down to silence across each half cycle, sign alternating
 *
 * Shape 7 is the only one that is not a rearrangement of the sine, and its
 * slope is fixed by the domain rather than chosen: a 9-bit ramp scaled by 8
 * spans 0…0xFF8, which is the same 96 dB the envelope and the exponential
 * table span. One half cycle is therefore exactly the chip's whole dynamic
 * range, top to bottom.
 */
export const SILENCE = 0x1000;

/** @param {number} shape @param {number} phase @param {number} outSign @returns {number} */
export function waveform(shape, phase, outSign) {
  const quarter = phase & 0xff;
  const mirrored = (phase & 0x100) !== 0 ? 255 - quarter : quarter;
  const negative = (phase & 0x200) !== 0;
  switch (shape & 7) {
    case 0:                                        // full sine
      outSign[0] = negative ? -1 : 1;
      return LOG_SIN[mirrored];
    case 1:                                        // half sine: bottom removed
      outSign[0] = 1;
      return negative ? SILENCE : LOG_SIN[mirrored];
    case 2:                                        // absolute sine
      outSign[0] = 1;
      return LOG_SIN[mirrored];
    case 3:                                        // pulse sine: rising quarters
      outSign[0] = 1;
      return (phase & 0x100) !== 0 ? SILENCE : LOG_SIN[quarter];
    case 4: {                                      // even sine: double rate, then silence
      outSign[0] = 1;
      if (negative) return SILENCE;
      // The first half cycle is stretched over a whole one, sign and all.
      const p = (phase << 1) & 0x3ff;
      const q = p & 0xff;
      outSign[0] = (p & 0x200) !== 0 ? -1 : 1;
      return LOG_SIN[(p & 0x100) !== 0 ? 255 - q : q];
    }
    case 5: {                                      // even absolute sine
      outSign[0] = 1;
      if (negative) return SILENCE;
      // As shape 4, but bit 9 -- the sign -- is dropped rather than read.
      const p = (phase << 1) & 0x1ff;
      const q = p & 0xff;
      return LOG_SIN[(p & 0x100) !== 0 ? 255 - q : q];
    }
    case 6:                                        // square
      outSign[0] = negative ? -1 : 1;
      return 0;
    default: {                                     // logarithmic sawtooth
      outSign[0] = negative ? -1 : 1;
      // Down across the first half, and back up across the second, so that the
      // two halves meet at silence rather than at a step.
      const ramp = phase & 0x1ff;
      return (negative ? 0x1ff - ramp : ramp) << 3;
    }
  }
}

/** How many waveforms register 0xE0 can select, by whether NEW is set. */
export const WAVE_MASK_OPL2 = 3, WAVE_MASK_OPL3 = 7;

// ── Low-frequency oscillators ─────────────────────────────────────────────
// Both are free-running and shared by every operator that opts in.

/** Vibrato depth in cents, by the depth bit in register 0xBD. */
export const VIBRATO_CENTS = Object.freeze([7, 14]);

/** Vibrato rate: one cycle every 8192 samples, ≈ 6.078 Hz. */
export const VIBRATO_PERIOD = 8192;

/** Tremolo depth in dB, by the depth bit in register 0xBD. */
export const TREMOLO_DB = Object.freeze([1.0, 4.8]);

/** Tremolo rate: ≈ 3.7 Hz. */
export const TREMOLO_PERIOD = 13440;

/** Tremolo depth expressed in envelope steps, ready to add to an attenuation. */
export const TREMOLO_STEPS = Object.freeze(
  TREMOLO_DB.map((db) => Math.round(db / 0.1875)),
);

/** Unit triangle, 0…1…0, for position p in [0, period). */
/** @param {number} p @param {number} period @returns {number} */
export function triangle(p, period) {
  const half = period >> 1;
  return p < half ? p / half : 2 - p / half;
}

/** Clamp an envelope value into the 9-bit attenuation range. */
/** @type {(v: number) => number} */
export const clampEnv = (v) => (v < 0 ? 0 : v > ENV_MAX ? ENV_MAX : v);
