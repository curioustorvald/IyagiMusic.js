// OPL2 (YM3812) and OPL3 (YMF262) constants.
//
// Everything here is either a hardware fact with a public citation or is
// derived from one in this file, in the open. Nothing is carried over from
// another emulator: see docs/OPL2_NOTES.en.md and docs/OPL3_NOTES.en.md for
// what is measured, what is derived and what is deliberately approximate.
//
// The two chips share this file because they share almost all of it. A YMF262
// is a YM3812 twice over -- the same operator, the same envelope, the same
// tables, the same nine-channel register bank -- plus a second bank, four more
// waveforms, four-operator channels and a stereo switch. Only the things in
// the OPL3 section below are new.

/** Crystal on an AdLib / Sound Blaster card. */
export const CHIP_CLOCK_HZ = 3579545;

/**
 * The chip walks all 18 operators in 72 master clocks, one output sample.
 *
 * A YMF262 has 36 operators and a 14.318 MHz crystal -- four times the clock
 * for twice the operators in 288 clocks -- so it lands on the same 49716 Hz
 * sample rate, which is why an OPL3 plays OPL2 songs at the right pitch.
 */
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
export const TL_STEP_DB = 0.75;
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

// ── OPL3 (YMF262) ─────────────────────────────────────────────────────────
// The second half of the chip. Everything above still applies to it.

/** Eighteen channels, thirty-six operators: the OPL2's nine, twice. */
export const OPL3_CHANNEL_COUNT = 18;
export const OPL3_OPERATOR_COUNT = 36;

/**
 * The second register bank sits at `reg | 0x100`, and holds a second copy of
 * every per-channel and per-operator register. The chip-wide ones -- 0x01,
 * 0x08, 0xBD -- exist only in bank 0.
 */
export const BANK_STRIDE = 0x100;

/**
 * 0x105 bit 0 is NEW: the switch from OPL2 compatibility into OPL3 proper.
 * With it clear a YMF262 is a YM3812 with a second bank it ignores -- nine
 * channels, four waveforms, no stereo, no four-operator channels.
 */
export const REG_OPL3_ENABLE = 0x105;
export const OPL3_NEW = 0x01;

/**
 * 0x104 bits 0..5 join six channel pairs into four-operator channels, one bit
 * per pair, in the order of FOUROP_PAIRS below.
 */
export const REG_FOUROP = 0x104;

/**
 * The six channel pairs that can be joined. Only these: a four-operator
 * channel is built from a channel and the one three above it in the same
 * bank, which is what puts its four operators on consecutive register offsets.
 * `[head, slave]` -- the head is the channel the pair is addressed by.
 */
export const FOUROP_PAIRS = Object.freeze([
  Object.freeze([0, 3]), Object.freeze([1, 4]), Object.freeze([2, 5]),
  Object.freeze([9, 12]), Object.freeze([10, 13]), Object.freeze([11, 14]),
]);

/**
 * Register 0xC0 bits 4 and 5, the stereo switches. They are enables, not a
 * pan: a channel is routed to the left output, the right, both or neither.
 * Both is centre, and neither is silence -- which is where a YMF262 comes up
 * after a reset, so a driver that never writes 0xC0 in OPL3 mode is mute.
 */
export const PAN_NONE = 0, PAN_LEFT = 1, PAN_RIGHT = 2, PAN_CENTRE = 3;
export const PAN_SHIFT = 4;

// ── Meter rows ────────────────────────────────────────────────────────────
// What a display wants is one row per *voice*, which is not one row per
// channel: in rhythm mode the chip's last three channels carry five
// instruments between them. The rows are numbered the way the driver numbers
// voices -- for an OPL2, 0…8 melodic, or 0…5 plus bass drum, snare, tom,
// cymbal and hi-hat; for an OPL3, 0…17 melodic, or 0…14 plus the same five.
// A caller can therefore index a row with the same voice number it plays.
//
// **The five rhythm rows are always the last five rows the chip has.** That is
// the one rule a display needs: 6…10 of 11 on an OPL2, 15…19 of 20 on an
// OPL3. `chip.rhythmRow` and `chip.voiceRows` say where they land.

/** Rows a meter buffer must hold: an OPL3 in rhythm mode, the widest case. */
export const METER_VOICES = 20;
export const METER_STRIDE = 8;

/** How many voices the rhythm mode carries, on either chip. */
export const RHYTHM_VOICES = 5;

/** The rhythm rows of an *OPL2*, which are its last five. */
export const METER_BD = 6, METER_SD = 7, METER_TOM = 8, METER_TC = 9, METER_HH = 10;

/** Offsets of the five rhythm voices from a chip's `rhythmRow`. */
export const R_BD = 0, R_SD = 1, R_TOM = 2, R_TC = 3, R_HH = 4;

/** Fields of one meter row. */
export const M_PEAK = 0;      // loudest |output| since the last read, ±1 scale
export const M_MOD_DB = 1;    // modulator attenuation in dB; -1 where there is none
export const M_NOTE = 2;      // MIDI note number, fractional; -1 where untuned
export const M_KEY_ON = 3;
export const M_STATE = 4;     // envelope phase of the voice's output operator
export const M_VOLUME = 5;    // channel volume 0…127 -- the driver's, not the chip's
export const M_TIMBRE = 6;    // packed, by the shifts below
export const M_PAN = 7;       // the 0xC0 stereo switches, as the PAN_* values

/**
 * Fields of M_TIMBRE. The two wave fields are three bits wide because an OPL3
 * has eight waveforms; an OPL2 only ever fills the low two of each.
 */
export const T_CAR_WAVE = 0, T_MOD_WAVE = 3, T_ADDITIVE = 6, T_FEEDBACK = 7,
  T_FOUROP = 10, T_CONN2 = 11;
export const T_WAVE_MASK = 7, T_FEEDBACK_MASK = 7;

/**
 * T_ADDITIVE and T_CONN2 are the two channels' CNT bits. On a two-operator
 * voice only the first has meaning -- modulation or addition. On a
 * four-operator voice the pair of them picks one of the four connections:
 *
 *   0,0   1 → 2 → 3 → 4          0,1   1 → 2 → 3, and 4
 *   1,0   1, and 2 → 3 → 4       1,1   1, and 2 → 3, and 4
 */

/** Chip-wide status bits, as `chipFlags` reports them. */
export const CF_RHYTHM = 1, CF_TREMOLO = 2, CF_VIBRATO = 4, CF_WAVESEL = 8,
  CF_OPL3 = 16, CF_FOUROP = 32;
