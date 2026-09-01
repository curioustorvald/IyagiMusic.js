// OPL2 (YM3812) — register interface in, samples out.
//
// Written from public hardware documentation rather than from another
// emulator; docs/OPL2_NOTES.en.md records what each part is derived from and
// where it is knowingly an approximation. The shape follows Microtone's engine
// modules: pure computation, no DOM and no Web Audio, a Float32 mix bus, and
// a render loop that fills a caller-owned buffer.

import {
  NATIVE_RATE, ENV_MAX, ENV_TO_LOG, TL_TO_LOG, KSL_TO_LOG,
  EG_OFF, EG_ATTACK, EG_DECAY, EG_SUSTAIN, EG_RELEASE,
  CHANNEL_COUNT, OPERATOR_COUNT, CHANNEL_OP_OFFSET, OPERATOR_OFFSET,
  RHYTHM_BD, RHYTHM_SD, RHYTHM_TOM, RHYTHM_TC, RHYTHM_HH,
  RHYTHM_HH_OP, RHYTHM_SD_OP, RHYTHM_TOM_OP, RHYTHM_TC_OP,
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

  /** One envelope step for one operator. Returns nothing; mutates `op.env`. */
  #advanceEnvelope(op) {
    if (op.state === EG_OFF) return;
    const rateParam =
      op.state === EG_ATTACK ? op.attack
      : op.state === EG_DECAY ? op.decay
      : op.state === EG_SUSTAIN ? (op.sustaining ? 0 : op.release)
      : op.release;
    if (rateParam === 0) {
      // A rate of zero is not "slow", it is "never".
      if (op.state === EG_SUSTAIN || op.state === EG_DECAY) return;
      if (op.state === EG_RELEASE) return;
    }
    const rate = rateParam === 0 ? 0 : Math.min(63, rateParam * 4 + op.ksrOffset);
    if (rate === 0) return;

    // The top four bits halve the period each step; the bottom two interpolate
    // by skipping four, five, six or seven of every eight opportunities.
    const shift = 14 - (rate >> 2);
    let step;
    if (shift >= 0) {
      if ((this.egCounter & ((1 << shift) - 1)) !== 0) return;
      step = EG_DUTY[rate & 3][(this.egCounter >> shift) & 7];
    } else {
      step = EG_DUTY[rate & 3][this.egCounter & 7] << -shift;
    }
    if (step === 0) return;

    switch (op.state) {
      case EG_ATTACK:
        // Exponential approach to full volume: the closer it gets, the
        // smaller the step, which is why attack rate 15 sounds instant.
        op.env -= ((op.env >> 3) + 1) * step;
        if (op.env <= 0) { op.env = 0; op.state = EG_DECAY; }
        break;
      case EG_DECAY:
        op.env += step;
        if (op.env >= op.sustainLevel) { op.env = op.sustainLevel; op.state = EG_SUSTAIN; }
        break;
      case EG_SUSTAIN:
        // Only reached when the operator is not "sustaining": it keeps
        // falling at the release rate while still keyed on.
        op.env += step;
        if (op.env >= ENV_MAX) { op.env = ENV_MAX; op.state = EG_OFF; }
        break;
      case EG_RELEASE:
        op.env += step;
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
        if (ch.additive) {
          mix += m + this.#operate(ch.car, 0, tremolo, vibrato);
        } else {
          mix += this.#operate(ch.car, (m / 2) | 0, tremolo, vibrato);
        }
      }
      if (this.rhythmMode) mix += this.#generateRhythm(tremolo, vibrato);

      // The chip sums nine channels into a 16-bit DAC; scale so that a single
      // full-amplitude operator is about 0.5 and a full mix stays inside ±1.
      out[offset + n] = Math.fround(mix / 16384);
      this.egCounter = (this.egCounter + 1) >>> 0;
      this.lfoPhase = (this.lfoPhase + 1) >>> 0;
      // 23-bit LFSR, tapped at 22 and 8 — the chip's own noise for the drums.
      this.noise = ((this.noise >>> 1) |
        (((this.noise ^ (this.noise >>> 14)) & 1) << 22)) >>> 0;
    }
  }

  /**
   * The five rhythm voices. Bass drum is an ordinary two-operator channel;
   * the other four are single operators driven by channel 7 and 8 phases and
   * by the noise generator. See docs/OPL2_NOTES.en.md — the metallic
   * instruments are a documented approximation, not a gate-level model.
   */
  #generateRhythm(tremolo, vibrato) {
    const ops = this.operators;
    const ch6 = this.channels[6];
    const ch7 = this.channels[7];
    const ch8 = this.channels[8];
    const hh = ops[OP_BY_OFFSET[RHYTHM_HH_OP]];
    const sd = ops[OP_BY_OFFSET[RHYTHM_SD_OP]];
    const tom = ops[OP_BY_OFFSET[RHYTHM_TOM_OP]];
    const tc = ops[OP_BY_OFFSET[RHYTHM_TC_OP]];
    for (const op of [ch6.mod, ch6.car, hh, sd, tom, tc]) this.#advanceEnvelope(op);

    let mix = 0;
    let fb = 0;
    if (ch6.feedback) fb = (ch6.mod.out + ch6.mod.prev) / 2 / (1 << (8 - ch6.feedback));
    const m = this.#operate(ch6.mod, fb | 0, tremolo, vibrato);
    mix += ch6.additive
      ? m + this.#operate(ch6.car, 0, tremolo, vibrato)
      : this.#operate(ch6.car, (m / 2) | 0, tremolo, vibrato);

    // Tom-tom is a plain sine on channel 8's frequency.
    mix += this.#operate(tom, 0, tremolo, vibrato);

    const noiseBit = this.noise & 1;
    const ph7 = (ch7.mod.phase >>> 10) & 0x3ff;
    const ph8 = (ch8.car.phase >>> 10) & 0x3ff;
    // The metallic pair: a square derived from both drum channels' phases.
    const metal = (((ph7 >> 8) ^ (ph7 >> 4)) | ((ph7 >> 6) ^ 1) |
                   ((ph8 >> 8) ^ (ph8 >> 5))) & 1;

    mix += this.#rhythmOperator(sd, ((ph7 >> 9) & 1) ^ noiseBit ? 0x200 : 0x000, tremolo);
    mix += this.#rhythmOperator(hh, metal ^ noiseBit ? 0x2d0 : 0x034, tremolo);
    mix += this.#rhythmOperator(tc, metal ? 0x300 : 0x100, tremolo);
    return mix;
  }

  /** A single-operator drum: the phase is dictated, not accumulated freely. */
  #rhythmOperator(op, phase, tremolo) {
    op.phase = (op.phase + op.phaseInc) >>> 0;
    if (op.state === EG_OFF) { op.prev = op.out; op.out = 0; return 0; }
    const logv = waveform(op.wave, phase, sign);
    if (logv === SILENCE) { op.prev = op.out; op.out = 0; return 0; }
    const v = expand(logv + this.#attenuation(op, tremolo)) * sign[0];
    op.prev = op.out;
    op.out = v;
    return v;
  }
}
