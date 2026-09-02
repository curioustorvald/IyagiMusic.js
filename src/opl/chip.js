// OPL2 (YM3812) — register interface in, samples out.
//
// Written from public hardware documentation rather than from another
// emulator; docs/OPL2_NOTES.en.md records what each part is derived from and
// where it is knowingly an approximation. The shape follows Microtone's engine
// modules: pure computation, no DOM and no Web Audio, a Float32 mix bus, and
// a render loop that fills a caller-owned buffer.

import {
  NATIVE_RATE, ENV_MAX, ENV_TO_LOG, TL_TO_LOG, KSL_TO_LOG,
  ENV_STEP_DB, TL_STEP_DB,
  EG_OFF, EG_ATTACK, EG_DECAY, EG_SUSTAIN, EG_RELEASE,
  CHANNEL_COUNT, OPERATOR_COUNT, CHANNEL_OP_OFFSET, OPERATOR_OFFSET,
  RHYTHM_BD, RHYTHM_SD, RHYTHM_TOM, RHYTHM_TC, RHYTHM_HH,
  RHYTHM_HH_OP, RHYTHM_SD_OP, RHYTHM_TOM_OP, RHYTHM_TC_OP,
  METER_VOICES, METER_STRIDE, METER_BD, METER_SD, METER_TOM, METER_TC, METER_HH,
  M_PEAK, M_MOD_DB, M_NOTE, M_KEY_ON, M_STATE, M_TIMBRE,
  T_CAR_WAVE, T_MOD_WAVE, T_ADDITIVE, T_FEEDBACK,
  CF_RHYTHM, CF_TREMOLO, CF_VIBRATO, CF_WAVESEL,
} from "./constants.js";
import {
  MULTIPLE_X2, SUSTAIN_LEVEL, EG_DUTY, LOG_SIN, SILENCE,
  kslAttenuation, KSL_SHIFT, waveform, expand, clampEnv,
  VIBRATO_CENTS, VIBRATO_PERIOD, TREMOLO_PERIOD, TREMOLO_STEPS, triangle,
} from "./tables.js";

/** Register offset → operator index. Sparse: 6, 7, 14, 15 are not operators. */
const OP_BY_OFFSET = (() => {
  const t = new Int8Array(32).fill(-1);
  OPERATOR_OFFSET.forEach((off, i) => { t[off] = i; });
  return t;
})();

/** Operator index → the channel it belongs to, in melodic mode. */
const OP_CHANNEL = (() => {
  const t = new Uint8Array(OPERATOR_COUNT);
  for (let c = 0; c < CHANNEL_COUNT; c++) {
    t[OP_BY_OFFSET[CHANNEL_OP_OFFSET[c]]] = c;
    t[OP_BY_OFFSET[CHANNEL_OP_OFFSET[c] + 3]] = c;
  }
  return t;
})();

/** True where the operator is its channel's carrier. */
const OP_IS_CARRIER = (() => {
  const t = new Uint8Array(OPERATOR_COUNT);
  for (let c = 0; c < CHANNEL_COUNT; c++) t[OP_BY_OFFSET[CHANNEL_OP_OFFSET[c] + 3]] = 1;
  return t;
})();

const sign = [0];

/** Nine channels into a 16-bit DAC: what `generate` divides its mix by. */
const MIX_SCALE = 16384;

class Operator {
  constructor(index) {
    this.index = index;
    this.channel = OP_CHANNEL[index];
    this.carrier = OP_IS_CARRIER[index] !== 0;
    this.reset();
  }

  reset() {
    this.am = false; this.vib = false; this.sustaining = false; this.ksr = false;
    this.multiple = 0; this.ksl = 0; this.totalLevel = 0;
    this.attack = 0; this.decay = 0; this.sustainLevel = 0; this.release = 0;
    this.wave = 0;
    this.phase = 0; this.phaseInc = 0;
    this.env = ENV_MAX; this.state = EG_OFF;
    this.out = 0; this.prev = 0;
    this.kslAtt = 0; this.ksrOffset = 0;
  }
}

class Channel {
  constructor(index) {
    this.index = index;
    this.fnum = 0; this.block = 0; this.keyOn = false;
    this.feedback = 0; this.additive = false;
    this.mod = null; this.car = null;
  }
}

export class OPL2 {
  constructor() {
    this.sampleRate = NATIVE_RATE;
    this.operators = Array.from({ length: OPERATOR_COUNT }, (_, i) => new Operator(i));
    this.channels = Array.from({ length: CHANNEL_COUNT }, (_, i) => new Channel(i));
    for (const ch of this.channels) {
      ch.mod = this.operators[OP_BY_OFFSET[CHANNEL_OP_OFFSET[ch.index]]];
      ch.car = this.operators[OP_BY_OFFSET[CHANNEL_OP_OFFSET[ch.index] + 3]];
    }
    this.registers = new Uint8Array(256);
    this.reset();
  }

  reset() {
    this.registers.fill(0);
    for (const op of this.operators) op.reset();
    for (const ch of this.channels) {
      ch.fnum = 0; ch.block = 0; ch.keyOn = false; ch.feedback = 0; ch.additive = false;
    }
    this.waveSelectEnabled = false;
    this.noteSelect = false;
    this.rhythmMode = false;
    this.rhythmBits = 0;
    this.amDepth = 0;
    this.vibDepth = 0;
    this.egCounter = 0;
    this.lfoPhase = 0;
    this.noise = 1;
    this.feedbackBuf = new Float64Array(CHANNEL_COUNT * 2);
    // Loudest sample each voice has produced since a display last looked.
    this.peaks = new Float32Array(METER_VOICES);
  }

  /** Write one chip register. Unknown addresses are stored and ignored. */
  write(reg, value) {
    reg &= 0xff; value &= 0xff;
    this.registers[reg] = value;
    // Operator registers address an operator by the low FIVE bits -- offsets
    // run to 0x15 -- while channel registers use the low four. Masking both
    // the same way silently aliases the third bank of operators onto the first.
    const group = reg & 0xe0;
    const chanGroup = reg & 0xf0;
    const opOffset = reg & 0x1f;
    const chanIndex = reg & 0x0f;

    if (reg === 0x01) { this.waveSelectEnabled = (value & 0x20) !== 0; return; }
    if (reg === 0x08) { this.noteSelect = (value & 0x40) !== 0; this.#retuneAll(); return; }
    if (reg === 0xbd) {
      this.amDepth = (value >> 7) & 1;
      this.vibDepth = (value >> 6) & 1;
      const wasRhythm = this.rhythmMode;
      this.rhythmMode = (value & 0x20) !== 0;
      if (this.rhythmMode !== wasRhythm) this.rhythmBits = 0;
      if (this.rhythmMode) this.#updateRhythm(value & 0x1f);
      return;
    }

    if (chanGroup === 0xa0 && chanIndex < CHANNEL_COUNT) {
      const ch = this.channels[chanIndex];
      ch.fnum = (ch.fnum & 0x300) | value;
      this.#retune(chanIndex);
      return;
    }
    if (chanGroup === 0xb0 && chanIndex < CHANNEL_COUNT) {
      const ch = this.channels[chanIndex];
      ch.fnum = (ch.fnum & 0xff) | ((value & 3) << 8);
      ch.block = (value >> 2) & 7;
      const on = (value & 0x20) !== 0;
      this.#retune(chanIndex);
      if (on !== ch.keyOn) {
        ch.keyOn = on;
        // In rhythm mode the two drum channels are keyed from 0xBD instead.
        if (!(this.rhythmMode && chanIndex >= 6)) {
          if (on) { this.#keyOn(ch.mod); this.#keyOn(ch.car); }
          else { this.#keyOff(ch.mod); this.#keyOff(ch.car); }
        }
      }
      return;
    }
    if (chanGroup === 0xc0 && chanIndex < CHANNEL_COUNT) {
      const ch = this.channels[chanIndex];
      ch.feedback = (value >> 1) & 7;
      ch.additive = (value & 1) !== 0;
      return;
    }

    if (opOffset > 0x15) return;
    const opIndex = OP_BY_OFFSET[opOffset];
    if (opIndex < 0) return;
    const op = this.operators[opIndex];
    switch (group) {
      case 0x20:
        op.am = (value & 0x80) !== 0;
        op.vib = (value & 0x40) !== 0;
        op.sustaining = (value & 0x20) !== 0;
        op.ksr = (value & 0x10) !== 0;
        op.multiple = value & 0x0f;
        this.#retune(op.channel);
        return;
      case 0x40:
        op.ksl = (value >> 6) & 3;
        op.totalLevel = value & 0x3f;
        this.#retune(op.channel);
        return;
      case 0x60:
        op.attack = (value >> 4) & 0x0f;
        op.decay = value & 0x0f;
        return;
      case 0x80:
        op.sustainLevel = SUSTAIN_LEVEL[(value >> 4) & 0x0f];
        op.release = value & 0x0f;
        return;
      case 0xe0:
        op.wave = value & 3;
        return;
      default:
        return;
    }
  }

  #keyOn(op) {
    op.state = EG_ATTACK;
    op.phase = 0;
    // An attack from silence still has to start somewhere; the chip restarts
    // the ramp from wherever the envelope currently sits.
    if (op.env >= ENV_MAX) op.env = ENV_MAX;
  }

  #keyOff(op) {
    if (op.state !== EG_OFF) op.state = EG_RELEASE;
  }

  #updateRhythm(bits) {
    const changed = bits ^ this.rhythmBits;
    this.rhythmBits = bits;
    const pairs = [
      [RHYTHM_BD, [this.channels[6].mod, this.channels[6].car]],
      [RHYTHM_HH, [this.operators[OP_BY_OFFSET[RHYTHM_HH_OP]]]],
      [RHYTHM_SD, [this.operators[OP_BY_OFFSET[RHYTHM_SD_OP]]]],
      [RHYTHM_TOM, [this.operators[OP_BY_OFFSET[RHYTHM_TOM_OP]]]],
      [RHYTHM_TC, [this.operators[OP_BY_OFFSET[RHYTHM_TC_OP]]]],
    ];
    for (const [mask, ops] of pairs) {
      if (!(changed & mask)) continue;
      for (const op of ops) (bits & mask) ? this.#keyOn(op) : this.#keyOff(op);
    }
  }

  #retuneAll() { for (let c = 0; c < CHANNEL_COUNT; c++) this.#retune(c); }

  /** Recompute an operator's phase increment, KSL attenuation and KSR offset. */
  #retune(channelIndex) {
    const ch = this.channels[channelIndex];
    const ksrValue = (ch.block << 1) |
      ((ch.fnum >> (this.noteSelect ? 9 : 8)) & 1);
    const kslBase = kslAttenuation(ch.block, ch.fnum);
    for (const op of [ch.mod, ch.car]) {
      op.phaseInc = ((ch.fnum * MULTIPLE_X2[op.multiple]) << ch.block) >> 1;
      op.ksrOffset = op.ksr ? ksrValue : ksrValue >> 2;
      const shift = KSL_SHIFT[op.ksl];
      op.kslAtt = shift === null ? 0 : kslBase >> shift;
    }
  }

  /**
   * One envelope tick for one operator. Mutates `op.env` and `op.state`.
   *
   * Timing follows Table 3-6 of the YM3812 application manual, which states
   * the attack and decay times for every key-scaled RATE = 4·R + Rks. Two
   * facts fix the whole clock. The rate's top four bits (RM) double the
   * envelope's speed at every step and its bottom two (RL) scale it by
   * (4 + RL)/4 -- the manual's four RL entries at a given RM are that ratio
   * exactly. And one envelope step being 0.1875 dB makes a full decay 512 of
   * them, which the manual's 9.60 ms at RM 13, RL 0 turns into one step a
   * sample. RM 15 saturates: all four of its RL entries read the same 2.40 ms.
   *
   * (The manual's absolute times are for a 3.84 MHz master clock. An AdLib
   * card runs 3.579545 MHz, so everything below comes out 7.3% slower than
   * the printed table -- the counter, not the millisecond figure, is the
   * hardware fact.)
   */
  #advanceEnvelope(op) {
    if (op.state === EG_OFF) return;
    const rateParam =
      op.state === EG_ATTACK ? op.attack
      : op.state === EG_DECAY ? op.decay
      : op.state === EG_SUSTAIN ? (op.sustaining ? 0 : op.release)
      : op.release;
    if (rateParam === 0) {
      // A rate of zero is not "slow", it is "never": §3-1-5 spells out that
      // RATE is 0 whenever R is 0, whatever the key scaling adds.
      if (op.state === EG_SUSTAIN || op.state === EG_DECAY) return;
      if (op.state === EG_RELEASE) return;
    }
    let rate = rateParam === 0 ? 0 : Math.min(63, rateParam * 4 + op.ksrOffset);
    if (rate === 0) return;
    if (rate > 60) rate = 60;                  // RM 15 ignores RL

    const shift = 12 - (rate >> 2);
    let steps;
    if (shift >= 0) {
      if ((this.egCounter & ((1 << shift) - 1)) !== 0) return;
      steps = EG_DUTY[rate & 3][(this.egCounter >> shift) & 7];
    } else {
      steps = EG_DUTY[rate & 3][this.egCounter & 7] << -shift;
    }
    if (steps === 0) return;

    // Above RM 12 the envelope moves more than once a sample. Those extra
    // moves are taken as separate unit steps rather than as one big one: the
    // decay is linear so it cannot tell the difference, but the attack closes
    // a fixed FRACTION of the remaining distance each step, and only
    // compounding keeps its shape -- the manual's ratio of decay time to
    // attack time is a constant 13.9 across every rate, and that constant is
    // what the unit step reproduces.
    const from = op.state;
    for (let i = 0; i < steps; i++) {
      this.#envelopeStep(op);
      if (op.state !== from) break;
    }
  }

  /** One 0.1875 dB move of the envelope, in whichever phase it is in. */
  #envelopeStep(op) {
    switch (op.state) {
      case EG_ATTACK:
        // Exponential approach to full volume: the closer it gets, the
        // smaller the step. 511 down to 0 takes 36 of these, which is the
        // 512/13.9 the manual's two time columns imply.
        op.env -= (op.env >> 3) + 1;
        if (op.env <= 0) { op.env = 0; op.state = EG_DECAY; }
        break;
      case EG_DECAY:
        op.env += 1;
        if (op.env >= op.sustainLevel) { op.env = op.sustainLevel; op.state = EG_SUSTAIN; }
        break;
      case EG_SUSTAIN:
        // Only reached when the operator is not "sustaining": §3-1-7 has a
        // diminishing sound switch to the release rate at the sustain level.
        op.env += 1;
        if (op.env >= ENV_MAX) { op.env = ENV_MAX; op.state = EG_OFF; }
        break;
      case EG_RELEASE:
        op.env += 1;
        if (op.env >= ENV_MAX) { op.env = ENV_MAX; op.state = EG_OFF; }
        break;
      default:
        break;
    }
    op.env = clampEnv(op.env);
  }

  /** Total attenuation of one operator this sample, in 1/256-log2 units. */
  #attenuation(op, tremolo) {
    let att = op.env * ENV_TO_LOG + op.totalLevel * TL_TO_LOG + op.kslAtt * KSL_TO_LOG;
    if (op.am) att += tremolo;
    return att;
  }

  /** Read one operator, advancing its phase. `mod` is a phase offset. */
  #operate(op, mod, tremolo, vibrato) {
    const att = this.#attenuation(op, tremolo);
    let inc = op.phaseInc;
    if (op.vib && vibrato !== 1) inc = Math.round(inc * vibrato);
    op.phase = (op.phase + inc) >>> 0;
    if (op.state === EG_OFF) { op.prev = op.out; op.out = 0; return 0; }
    const index = ((op.phase >>> 10) + mod) & 0x3ff;
    const logv = waveform(op.wave, index, sign);
    if (logv === SILENCE) { op.prev = op.out; op.out = 0; return 0; }
    const v = expand(logv + att) * sign[0];
    op.prev = op.out;
    op.out = v;
    return v;
  }

  /**
   * Render `count` samples into `out` starting at `offset`, at the chip's
   * native rate. Output is roughly ±1 after the /4096 scaling below.
   */
  generate(out, offset, count) {
    const chans = this.channels;
    for (let n = 0; n < count; n++) {
      const tremolo = TREMOLO_STEPS[this.amDepth] * ENV_TO_LOG *
        triangle(this.lfoPhase % TREMOLO_PERIOD, TREMOLO_PERIOD);
      const vibCents = VIBRATO_CENTS[this.vibDepth] *
        (2 * triangle(this.lfoPhase % VIBRATO_PERIOD, VIBRATO_PERIOD) - 1);
      const vibrato = vibCents === 0 ? 1 : 2 ** (vibCents / 1200);

      let mix = 0;
      const melodicChannels = this.rhythmMode ? 6 : CHANNEL_COUNT;
      for (let c = 0; c < melodicChannels; c++) {
        const ch = chans[c];
        this.#advanceEnvelope(ch.mod);
        this.#advanceEnvelope(ch.car);
        let fb = 0;
        if (ch.feedback) {
          // The average of the last two outputs, scaled so that feedback 7 is
          // the documented 4π of phase modulation at full amplitude.
          fb = (ch.mod.out + ch.mod.prev) / 2 / (1 << (8 - ch.feedback));
        }
        const m = this.#operate(ch.mod, fb | 0, tremolo, vibrato);
        mix += this.#tally(c, ch.additive
          ? m + this.#operate(ch.car, 0, tremolo, vibrato)
          : this.#operate(ch.car, (m / 2) | 0, tremolo, vibrato));
      }
      if (this.rhythmMode) mix += this.#generateRhythm(tremolo, vibrato);

      // The chip sums nine channels into a 16-bit DAC; scale so that a single
      // full-amplitude operator is about 0.5 and a full mix stays inside ±1.
      out[offset + n] = Math.fround(mix / MIX_SCALE);
      this.egCounter = (this.egCounter + 1) >>> 0;
      this.lfoPhase = (this.lfoPhase + 1) >>> 0;
      // 23-bit LFSR, tapped at 22 and 8 — the chip's own noise for the drums.
      this.noise = ((this.noise >>> 1) |
        (((this.noise ^ (this.noise >>> 14)) & 1) << 22)) >>> 0;
    }
  }

  /**
   * The five rhythm voices.
   *
   * The bass drum is an ordinary two-operator channel and the tom-tom an
   * ordinary free-running sine. The other three are not oscillators at all:
   * the chip throws away their phase accumulators' low bits and builds a
   * phase out of single bits of the hi-hat's and top cymbal's accumulators,
   * so that all three come out inharmonic and share one timbre family. Their
   * envelopes, levels and F-numbers still work normally.
   *
   *   hh = channel 8's modulator phase, tc = channel 9's carrier phase, both
   *   as the 10-bit index the waveform table takes
   *
   *   xor = (hh2 ^ hh7) | hh3 | (tc5 ^ tc3)
   *
   *   hi-hat      (xor << 9) | (xor ^ noise ? 0x0d0 : 0x034)
   *   snare drum  (hh8 ? 0x200 : 0x100) ^ (noise << 8)
   *   top cymbal  (xor << 9) | 0x100
   *
   * This is the hardware's own function, from the published description of
   * the die rather than from anyone's code -- see docs/OPL2_NOTES.en.md. The
   * application manual documents the drums only as tonal advice (§5-4) and
   * says nothing about how they are generated.
   */
  #generateRhythm(tremolo, vibrato) {
    const ops = this.operators;
    const ch6 = this.channels[6];
    const hh = ops[OP_BY_OFFSET[RHYTHM_HH_OP]];
    const sd = ops[OP_BY_OFFSET[RHYTHM_SD_OP]];
    const tom = ops[OP_BY_OFFSET[RHYTHM_TOM_OP]];
    const tc = ops[OP_BY_OFFSET[RHYTHM_TC_OP]];
    for (const op of [ch6.mod, ch6.car, hh, sd, tom, tc]) this.#advanceEnvelope(op);

    let mix = 0;
    let fb = 0;
    if (ch6.feedback) fb = (ch6.mod.out + ch6.mod.prev) / 2 / (1 << (8 - ch6.feedback));
    const m = this.#operate(ch6.mod, fb | 0, tremolo, vibrato);
    mix += this.#tally(METER_BD, ch6.additive
      ? m + this.#operate(ch6.car, 0, tremolo, vibrato)
      : this.#operate(ch6.car, (m / 2) | 0, tremolo, vibrato));

    // Tom-tom is a plain sine on channel 9's frequency.
    mix += this.#tally(METER_TOM, this.#operate(tom, 0, tremolo, vibrato));

    // The remaining three read each other's accumulators, so every phase has
    // to be advanced before any of them is sampled.
    hh.phase = (hh.phase + hh.phaseInc) >>> 0;
    sd.phase = (sd.phase + sd.phaseInc) >>> 0;
    tc.phase = (tc.phase + tc.phaseInc) >>> 0;
    const hp = (hh.phase >>> 10) & 0x3ff;
    const tp = (tc.phase >>> 10) & 0x3ff;
    const noise = this.noise & 1;
    const xor = (((hp >> 2) ^ (hp >> 7)) | (hp >> 3) | ((tp >> 5) ^ (tp >> 3))) & 1;

    mix += this.#tally(METER_HH,
      this.#rhythmOperator(hh, (xor << 9) | (xor ^ noise ? 0x0d0 : 0x034), tremolo));
    mix += this.#tally(METER_SD,
      this.#rhythmOperator(sd, (((hp >> 8) & 1) ? 0x200 : 0x100) ^ (noise << 8), tremolo));
    mix += this.#tally(METER_TC,
      this.#rhythmOperator(tc, (xor << 9) | 0x100, tremolo));
    return mix;
  }

  /**
   * Note one voice's contribution to the mix, and pass it through. This runs
   * on every voice of every sample whether or not anyone is watching, which
   * costs a few per cent of the render; a flag to switch it off would only
   * trade that for a display that can show stale silence.
   */
  #tally(voice, value) {
    const level = value < 0 ? -value : value;
    if (level > this.peaks[voice]) this.peaks[voice] = level;
    return value;
  }

  /** A single-operator drum: the phase is dictated, not accumulated freely. */
  #rhythmOperator(op, phase, tremolo) {
    if (op.state === EG_OFF) { op.prev = op.out; op.out = 0; return 0; }
    const logv = waveform(op.wave, phase, sign);
    if (logv === SILENCE) { op.prev = op.out; op.out = 0; return 0; }
    const v = expand(logv + this.#attenuation(op, tremolo)) * sign[0];
    op.prev = op.out;
    op.out = v;
    return v;
  }

  // ── What the chip looks like from outside ──────────────────────────────
  // A display cannot ask the chip for a spectrum -- nothing here ever
  // computes one -- but it can ask what each voice is doing, which is more
  // to the point on a nine-voice FM chip anyway.

  /** Chip-wide switches, as the CF_* bits. */
  get chipFlags() {
    return (this.rhythmMode ? CF_RHYTHM : 0) | (this.amDepth ? CF_TREMOLO : 0) |
      (this.vibDepth ? CF_VIBRATO : 0) | (this.waveSelectEnabled ? CF_WAVESEL : 0);
  }

  /**
   * Fill `out` with one METER_STRIDE-wide row per voice and return it.
   *
   * Reading clears the peak accumulators, so each call reports the loudest
   * sample since the last one -- which is what a peak meter wants, and why
   * two readers cannot share one chip. M_VOLUME is left alone: channel volume
   * is the driver's idea, not a register the chip holds.
   *
   * @param {Float32Array} out at least METER_VOICES * METER_STRIDE long
   */
  readMeters(out) {
    out.fill(0);
    const melodic = this.rhythmMode ? 6 : CHANNEL_COUNT;
    for (let c = 0; c < melodic; c++) this.#meterChannel(out, c, this.channels[c]);
    if (this.rhythmMode) {
      const bits = this.rhythmBits;
      const ops = this.operators;
      this.#meterChannel(out, METER_BD, this.channels[6], (bits & RHYTHM_BD) !== 0);
      // The other four are one operator each. Only the tom is tonal: the
      // hi-hat, snare and cymbal build their phase out of bits of each
      // other's accumulators, so their channel's F-number is not a pitch and
      // reporting it as one would invent a note nobody is playing.
      const tomNote = this.#noteOf(this.channels[8]);
      this.#meterOperator(out, METER_SD, ops[OP_BY_OFFSET[RHYTHM_SD_OP]], bits & RHYTHM_SD, -1);
      this.#meterOperator(out, METER_TOM, ops[OP_BY_OFFSET[RHYTHM_TOM_OP]], bits & RHYTHM_TOM, tomNote);
      this.#meterOperator(out, METER_TC, ops[OP_BY_OFFSET[RHYTHM_TC_OP]], bits & RHYTHM_TC, -1);
      this.#meterOperator(out, METER_HH, ops[OP_BY_OFFSET[RHYTHM_HH_OP]], bits & RHYTHM_HH, -1);
    }
    this.peaks.fill(0);
    return out;
  }

  #meterChannel(out, row, ch, keyOn = ch.keyOn) {
    const o = row * METER_STRIDE;
    out[o + M_PEAK] = this.peaks[row] / MIX_SCALE;
    out[o + M_MOD_DB] = this.#attenuationDb(ch.mod);
    out[o + M_NOTE] = this.#noteOf(ch);
    out[o + M_KEY_ON] = keyOn ? 1 : 0;
    out[o + M_STATE] = ch.car.state;
    out[o + M_TIMBRE] = (ch.car.wave << T_CAR_WAVE) | (ch.mod.wave << T_MOD_WAVE) |
      ((ch.additive ? 1 : 0) << T_ADDITIVE) | (ch.feedback << T_FEEDBACK);
  }

  #meterOperator(out, row, op, keyOn, note) {
    const o = row * METER_STRIDE;
    out[o + M_PEAK] = this.peaks[row] / MIX_SCALE;
    out[o + M_MOD_DB] = -1;                    // one operator: nothing modulates it
    out[o + M_NOTE] = note;
    out[o + M_KEY_ON] = keyOn ? 1 : 0;
    out[o + M_STATE] = op.state;
    out[o + M_TIMBRE] = op.wave << T_CAR_WAVE;
  }

  /** An operator's standing attenuation in dB: envelope, level and key scale. */
  #attenuationDb(op) {
    return op.env * ENV_STEP_DB + (op.totalLevel + op.kslAtt) * TL_STEP_DB;
  }

  /** A channel's F-number and block read back as a MIDI note, or -1 if unset. */
  #noteOf(ch) {
    if (!ch.fnum) return -1;
    const hz = ch.fnum * NATIVE_RATE / (1 << (20 - ch.block));
    return 69 + 12 * Math.log2(hz / 440);
  }
}
