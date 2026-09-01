// OPL2 (YM3812) constants.
//
// Everything here is either a hardware fact with a public citation or is
// derived from one in this file, in the open. Nothing is carried over from
// another emulator: see docs/OPL2_NOTES.en.md for what is measured, what is
// derived and what is deliberately approximate.

/** Crystal on an AdLib / Sound Blaster card. */
export const CHIP_CLOCK_HZ = 3579545;

/** The chip walks all 18 operators in 72 master clocks, one output sample. */
export const CLOCKS_PER_SAMPLE = 72;

/** 49716.05 Hz. Every timing constant below is expressed against this. */
export const NATIVE_RATE = CHIP_CLOCK_HZ / CLOCKS_PER_SAMPLE;

// ── The attenuation domain ────────────────────────────────────────────────
// Two scales meet in the 0x40 register. The envelope generator counts in
// 0.1875 dB and is 9 bits wide, so it spans 0…95.8 dB. Total level counts in
// 0.75 dB and is 6 bits wide. Both are converted into the log2 domain the
// exponential table wants, whose unit is 1/256 of a power of two — that is
// 6.0206/256 = 0.02352 dB, so one envelope step is 8 of them and one total
// level step is 32.

export const ENV_MAX = 511;
export const ENV_STEP_DB = 0.1875;
export const LOG_UNITS_PER_DB = 256 / Math.log10(2) / 20;   // ≈ 42.52
export const ENV_TO_LOG = 8;
export const TL_TO_LOG = 32;
export const KSL_TO_LOG = 32;              // the KSL table counts in 0.75 dB too

/** Envelope generator phases. */
export const EG_OFF = 0;
export const EG_ATTACK = 1;
export const EG_DECAY = 2;
export const EG_SUSTAIN = 3;
export const EG_RELEASE = 4;

// ── Channel and operator geometry ─────────────────────────────────────────

export const CHANNEL_COUNT = 9;
export const OPERATOR_COUNT = 18;

/** Register offset of channel c's modulator; the carrier is +3. */
export const CHANNEL_OP_OFFSET = Object.freeze([0, 1, 2, 8, 9, 10, 16, 17, 18]);

/** Every operator's register offset, in operator-index order. */
export const OPERATOR_OFFSET = Object.freeze([
  0, 1, 2, 3, 4, 5,
  8, 9, 10, 11, 12, 13,
  16, 17, 18, 19, 20, 21,
]);

// ── Rhythm mode ───────────────────────────────────────────────────────────
// Five instruments on six operators, keyed by register 0xBD rather than by
// the channels' own key-on bits.

export const RHYTHM_BD = 0x10;
export const RHYTHM_SD = 0x08;
export const RHYTHM_TOM = 0x04;
export const RHYTHM_TC = 0x02;
export const RHYTHM_HH = 0x01;

/** Operator register offsets of the four single-operator rhythm voices. */
export const RHYTHM_HH_OP = 17;    // channel 7 modulator
export const RHYTHM_SD_OP = 20;    // channel 7 carrier
export const RHYTHM_TOM_OP = 18;   // channel 8 modulator
export const RHYTHM_TC_OP = 21;    // channel 8 carrier
