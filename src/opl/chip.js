// OPL2 (YM3812) and OPL3 (YMF262) — register interface in, samples out.
//
// Written from public hardware documentation rather than from another
// emulator; docs/OPL2_NOTES.en.md and docs/OPL3_NOTES.en.md record what each
// part is derived from and where it is knowingly an approximation. The shape
// follows Microtone's engine modules: pure computation, no DOM and no Web
// Audio, a Float32 mix bus, and a render loop that fills a caller-owned buffer.
//
// One core serves both chips, because a YMF262 *is* a YM3812 twice over. The
// operator, the envelope, the tables, the rhythm generator and the nine-channel
// register bank are the same silicon; the OPL3 adds a second bank of nine
// channels, four more waveforms, six channel pairs that can be joined into
// four-operator voices, and a stereo switch per channel. Every one of those is
// gated on the NEW bit (register 0x105), which is what lets a YMF262 come up
// pretending to be a YM3812 -- so an OPL2 is not a special case bolted on here,
// it is the state this core is in before anything turns the extras on.

import {
  NATIVE_RATE, ENV_MAX, ENV_TO_LOG, TL_TO_LOG, KSL_TO_LOG,
  ENV_STEP_DB, TL_STEP_DB,
  EG_OFF, EG_ATTACK, EG_DECAY, EG_SUSTAIN, EG_RELEASE,
  CHANNEL_COUNT, OPERATOR_COUNT, CHANNEL_OP_OFFSET, OPERATOR_OFFSET,
  OPL3_CHANNEL_COUNT, REG_OPL3_ENABLE, OPL3_NEW, REG_FOUROP,
  FOUROP_PAIRS, PAN_CENTRE, PAN_SHIFT,
  RHYTHM_BD, RHYTHM_SD, RHYTHM_TOM, RHYTHM_TC, RHYTHM_HH,
  RHYTHM_HH_OP, RHYTHM_SD_OP, RHYTHM_TOM_OP, RHYTHM_TC_OP,
  RHYTHM_VOICES, R_BD, R_SD, R_TOM, R_TC, R_HH,
  METER_VOICES, METER_STRIDE,
  M_PEAK, M_MOD_DB, M_NOTE, M_KEY_ON, M_STATE, M_TIMBRE, M_PAN,
  T_CAR_WAVE, T_MOD_WAVE, T_ADDITIVE, T_FEEDBACK, T_FOUROP, T_CONN2,
  CF_RHYTHM, CF_TREMOLO, CF_VIBRATO, CF_WAVESEL, CF_OPL3, CF_FOUROP,
} from "./constants.js";
import {
  MULTIPLE_X2, SUSTAIN_LEVEL, EG_DUTY, SILENCE,
  kslAttenuation, KSL_SHIFT, waveform, expand, clampEnv,
  WAVE_MASK_OPL2, WAVE_MASK_OPL3,
  VIBRATO_CENTS, VIBRATO_PERIOD, TREMOLO_PERIOD, TREMOLO_STEPS, triangle,
} from "./tables.js";

/**
 * Register offset → operator index *within one bank*. Sparse: 6, 7, 14 and 15
 * are not operators. An OPL3's second bank repeats the same nineteen offsets
 * at `reg | 0x100`, and its operators are these eighteen plus OPERATOR_COUNT.
 */
const OP_BY_OFFSET = (() => {
  const t = new Int8Array(32).fill(-1);
  OPERATOR_OFFSET.forEach((off, i) => { t[off] = i; });
  return t;
})();

/** Operator index → the channel it belongs to, within its bank. */
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

/**
 * Nine channels into a 16-bit DAC: what the render loop divides its mix by.
 *
 * The same figure serves both chips, because one OPL3 voice is exactly as loud
 * as one OPL2 voice -- the per-channel DAC level is the same silicon. An OPL3
 * song running twenty voices therefore reaches a larger number than an OPL2
 * one running nine, which is a fact about the chip rather than a scaling
 * mistake: a real YMF262 clips there too. Backing off is the player's job, and
 * `IyagiMusic` picks its default gain by how many voices the song can reach.
 */
const MIX_SCALE = 16384;
/** How many times a rhythm voice reaches the accumulator; see `#generateRhythm`. */
const RHYTHM_MIX = 2;

/** `Channel.pairRole`: not in a four-operator pair, the pair's head, its slave. */
const PAIR_NONE = 0, PAIR_HEAD = 1, PAIR_SLAVE = 2;

class Operator {
  /** @param {number} index @param {number} bank */
  constructor(index, bank) {
    this.index = index;
    this.bank = bank;
    this.channel = OP_CHANNEL[index % OPERATOR_COUNT] + bank * CHANNEL_COUNT;
    this.carrier = OP_IS_CARRIER[index % OPERATOR_COUNT] !== 0;
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
  /** @param {number} index */
  constructor(index) {
    this.index = index;
    this.bank = index >= CHANNEL_COUNT ? 1 : 0;
    this.fnum = 0; this.block = 0; this.keyOn = false;
    this.feedback = 0; this.additive = false;
    // OPL3 only, and both true until something says otherwise: a YM3812 has
    // one output and routes every channel to it.
    this.left = true; this.right = true;
    /** @type {number} PAIR_NONE, PAIR_HEAD or PAIR_SLAVE. */
    this.pairRole = PAIR_NONE;
    /** @type {number} The pair's other channel, or -1. */
    this.pairWith = -1;
    // Wired up by the chip's constructor: a channel's two operators are not
    // adjacent, and the map lives there.
    /** @type {Operator|null} */ this.mod = null;
    /** @type {Operator|null} */ this.car = null;
  }
}

/**
 * The shared core. `OPL2` and `OPL3` below are the two ways it is built; there
 * is no third, and nothing outside this file constructs one directly.
 */
class OplChip {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.opl3] whether the second bank and its extras exist
   */
  constructor(opts = {}) {
    /** @type {boolean} Whether this is a YMF262 at all. */
    this.opl3 = !!opts.opl3;
    this.sampleRate = NATIVE_RATE;
    this.channelCount = this.opl3 ? OPL3_CHANNEL_COUNT : CHANNEL_COUNT;
    this.operatorCount = this.channelCount * 2;
    this.registerMask = this.opl3 ? 0x1ff : 0xff;

    this.operators = Array.from({ length: this.operatorCount },
      (_, i) => new Operator(i, i >= OPERATOR_COUNT ? 1 : 0));
    this.channels = Array.from({ length: this.channelCount }, (_, i) => new Channel(i));
    for (const ch of this.channels) {
      const local = ch.index % CHANNEL_COUNT;
      const base = ch.bank * OPERATOR_COUNT;
      ch.mod = this.operators[OP_BY_OFFSET[CHANNEL_OP_OFFSET[local]] + base];
      ch.car = this.operators[OP_BY_OFFSET[CHANNEL_OP_OFFSET[local] + 3] + base];
    }
    this.registers = new Uint8Array(this.opl3 ? 512 : 256);
    /** @type {Int32Array} channel index → meter row, or -1 while it is not a voice. */
    this.rowOfChannel = new Int32Array(this.channelCount);
    this.reset();
  }

  reset() {
    this.registers.fill(0);
    for (const op of this.operators) op.reset();
    for (const ch of this.channels) {
      ch.fnum = 0; ch.block = 0; ch.keyOn = false; ch.feedback = 0; ch.additive = false;
      ch.left = true; ch.right = true;
      ch.pairRole = PAIR_NONE; ch.pairWith = -1;
    }
    this.waveSelectEnabled = false;
    this.noteSelect = false;
    this.rhythmMode = false;
    /** @type {number} */
    this.rhythmBits = 0;
    this.amDepth = 0;
    this.vibDepth = 0;
    this.egCounter = 0;
    this.lfoPhase = 0;
    this.noise = 1;
    /** @type {boolean} The NEW bit: everything the OPL3 adds hangs off it. */
    this.newMode = false;
    /** @type {number} Register 0x104: one bit per pair of FOUROP_PAIRS. */
    this.fourOpBits = 0;
    this.feedbackBuf = new Float64Array(this.channelCount * 2);
    // Loudest sample each voice has produced since a display last looked.
    this.peaks = new Float32Array(METER_VOICES);
    this.#rebuildVoiceMap();
  }

  /** How many channels are actually playing: nine, or eighteen in OPL3 mode. */
  get activeChannels() {
    return this.opl3 && this.newMode ? OPL3_CHANNEL_COUNT : CHANNEL_COUNT;
  }

  /** Waveforms register 0xE0 can currently reach: four, or eight in OPL3 mode. */
  get waveMask() {
    return this.opl3 && this.newMode ? WAVE_MASK_OPL3 : WAVE_MASK_OPL2;
  }

  /** Whether the chip's output is two channels rather than one. */
  get stereo() { return this.opl3 && this.newMode; }

  /**
   * Write one chip register. Unknown addresses are stored and ignored.
   *
   * An OPL3 takes nine address bits rather than eight: `reg | 0x100` reaches
   * the second bank, which holds a second copy of every per-channel and
   * per-operator register. The chip-wide ones -- 0x01, 0x08, 0xBD -- live only
   * in bank 0, and 0x104 and 0x105 only in bank 1.
   *
   * @param {number} reg @param {number} value
   */
  write(reg, value) {
    reg &= this.registerMask; value &= 0xff;
    this.registers[reg] = value;
    const bank = reg >> 8;
    const low = reg & 0xff;
    // Operator registers address an operator by the low FIVE bits -- offsets
    // run to 0x15 -- while channel registers use the low four. Masking both
    // the same way silently aliases the third bank of operators onto the first.
    const group = low & 0xe0;
    const chanGroup = low & 0xf0;
    const opOffset = low & 0x1f;
    const chanIndex = (low & 0x0f) + bank * CHANNEL_COUNT;

    if (bank === 1) {
      if (low === (REG_FOUROP & 0xff)) {
        this.fourOpBits = value & 0x3f;
        this.#rebuildFourOp();
        return;
      }
      if (low === (REG_OPL3_ENABLE & 0xff)) {
        const on = (value & OPL3_NEW) !== 0;
        if (on !== this.newMode) {
          this.newMode = on;
          // Waveform width, the second bank and the pairs all follow NEW, so
          // everything derived from it has to be recomputed rather than
          // waiting for the next write to each register.
          this.#remaskWaves();
          this.#rebuildFourOp();
          this.#rebuildVoiceMap();
        }
        return;
      }
    } else {
      if (low === 0x01) { this.waveSelectEnabled = (value & 0x20) !== 0; return; }
      if (low === 0x08) { this.noteSelect = (value & 0x40) !== 0; this.#retuneAll(); return; }
      if (low === 0xbd) {
        this.amDepth = (value >> 7) & 1;
        this.vibDepth = (value >> 6) & 1;
        const wasRhythm = this.rhythmMode;
        this.rhythmMode = (value & 0x20) !== 0;
        if (this.rhythmMode !== wasRhythm) { this.rhythmBits = 0; this.#rebuildVoiceMap(); }
        if (this.rhythmMode) this.#updateRhythm(value & 0x1f);
        return;
      }
    }

    if (chanGroup === 0xa0 && (low & 0x0f) < CHANNEL_COUNT) {
      const ch = this.channels[chanIndex];
      if (!ch) return;
      ch.fnum = (ch.fnum & 0x300) | value;
      this.#retune(chanIndex);
      return;
    }
    if (chanGroup === 0xb0 && (low & 0x0f) < CHANNEL_COUNT) {
      const ch = this.channels[chanIndex];
      if (!ch) return;
      ch.fnum = (ch.fnum & 0xff) | ((value & 3) << 8);
      ch.block = (value >> 2) & 7;
      const on = (value & 0x20) !== 0;
      this.#retune(chanIndex);
      if (on !== ch.keyOn) {
        ch.keyOn = on;
        // In rhythm mode the two drum channels are keyed from 0xBD instead,
        // and the slave half of a four-operator pair is keyed by its head.
        const drumChannel = this.rhythmMode && bank === 0 && (low & 0x0f) >= 6;
        if (!drumChannel && ch.pairRole !== PAIR_SLAVE) this.#keyChannel(ch, on);
      }
      return;
    }
    if (chanGroup === 0xc0 && (low & 0x0f) < CHANNEL_COUNT) {
      const ch = this.channels[chanIndex];
      if (!ch) return;
      ch.feedback = (value >> 1) & 7;
      ch.additive = (value & 1) !== 0;
      // Bits 4 and 5 are the stereo switches. They do not exist on a YM3812,
      // and a YMF262 ignores them until NEW is set -- which is the only reason
      // an OPL2 song does not fall silent on an OPL3 the moment it writes 0xC0.
      ch.left = (value & (1 << PAN_SHIFT)) !== 0;
      ch.right = (value & (2 << PAN_SHIFT)) !== 0;
      return;
    }

    if (opOffset > 0x15) return;
    const localOp = OP_BY_OFFSET[opOffset];
    if (localOp < 0) return;
    const op = this.operators[localOp + bank * OPERATOR_COUNT];
    if (!op) return;
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
        op.wave = value & this.waveMask;
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

  /** Key a whole voice, which for a four-operator pair is four operators. */
  #keyChannel(ch, on) {
    const key = on ? (op) => this.#keyOn(op) : (op) => this.#keyOff(op);
    key(ch.mod); key(ch.car);
    if (ch.pairRole === PAIR_HEAD) {
      const slave = this.channels[ch.pairWith];
      key(slave.mod); key(slave.car);
    }
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

  /**
   * Which channels are voices, and in what order a display should read them.
   *
   * This is the one piece of bookkeeping that differs between the two chips,
   * and it is the same rule for both: the melodic channels in register order,
   * minus the three the rhythm mode takes over, and then the five rhythm
   * voices on the end. Nine channels give 9 rows, or 6 + 5; eighteen give 18,
   * or 15 + 5. The rhythm voices are therefore always the last five rows,
   * whichever chip this is.
   */
  #rebuildVoiceMap() {
    const active = this.activeChannels;
    const order = [];
    for (let c = 0; c < (this.rhythmMode ? 6 : Math.min(CHANNEL_COUNT, active)); c++) {
      order.push(c);
    }
    for (let c = CHANNEL_COUNT; c < active; c++) order.push(c);
    /** @type {number[]} melodic channel indices, in meter-row order */
    this.melodicOrder = order;
    /** @type {number} how many meter rows this chip currently has */
    this.voiceRows = order.length + (this.rhythmMode ? RHYTHM_VOICES : 0);
    /** @type {number} the row the bass drum lands on, or -1 outside rhythm mode */
    this.rhythmRow = this.rhythmMode ? order.length : -1;
    this.rowOfChannel.fill(-1);
    for (let i = 0; i < order.length; i++) this.rowOfChannel[order[i]] = i;
  }

  /** Re-read register 0x104 into the channels' pair roles. */
  #rebuildFourOp() {
    for (const ch of this.channels) { ch.pairRole = PAIR_NONE; ch.pairWith = -1; }
    if (this.opl3 && this.newMode) {
      for (let i = 0; i < FOUROP_PAIRS.length; i++) {
        if (!(this.fourOpBits & (1 << i))) continue;
        const [head, slave] = FOUROP_PAIRS[i];
        this.channels[head].pairRole = PAIR_HEAD;
        this.channels[head].pairWith = slave;
        this.channels[slave].pairRole = PAIR_SLAVE;
        this.channels[slave].pairWith = head;
      }
    }
    // A slave's operators take their pitch from the head, so joining or
    // splitting a pair retunes four operators at once.
    this.#retuneAll();
  }

  /** NEW widens register 0xE0 from two bits to three; narrowing it takes back. */
  #remaskWaves() {
    const mask = this.waveMask;
    for (const op of this.operators) op.wave &= mask;
  }

  #retuneAll() { for (let c = 0; c < this.channelCount; c++) this.#retune(c); }

  /**
   * Recompute an operator's phase increment, KSL attenuation and KSR offset.
   *
   * A four-operator pair is one voice with one pitch: the slave half's own
   * F-number and block are not read, and all four operators follow the head's.
   * The driver writes the same F-number to both halves anyway, so the corpus
   * cannot tell the two readings apart -- see docs/OPL3_NOTES.en.md.
   */
  #retune(channelIndex) {
    const ch = this.channels[channelIndex];
    if (!ch) return;
    const tune = ch.pairRole === PAIR_SLAVE ? this.channels[ch.pairWith] : ch;
    const ksrValue = (tune.block << 1) |
      ((tune.fnum >> (this.noteSelect ? 9 : 8)) & 1);
    const kslBase = kslAttenuation(tune.block, tune.fnum);
    for (const op of [ch.mod, ch.car]) {
      op.phaseInc = ((tune.fnum * MULTIPLE_X2[op.multiple]) << tune.block) >> 1;
      op.ksrOffset = op.ksr ? ksrValue : ksrValue >> 2;
      const shift = KSL_SHIFT[op.ksl];
      op.kslAtt = shift === null ? 0 : kslBase >> shift;
    }
    if (ch.pairRole === PAIR_HEAD) this.#retune(ch.pairWith);
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
   * The phase modulation a channel's modulator feeds back into itself.
   *
   * The average of the last two outputs, scaled so that feedback 7 is the
   * documented 4π of phase modulation at full amplitude. Note that this is a
   * QUARTER of what the direct modulation path carries -- an operator reading
   * another one gets its output whole (see `#twoOp`) -- which is the ordinary
   * relationship on an FM chip: feedback is a fraction of full modulation.
   * The two were equal here once, and that was the bug; see OPL2_NOTES.
   */
  #feedbackOf(ch) {
    if (!ch.feedback) return 0;
    return ((ch.mod.out + ch.mod.prev) / 2 / (1 << (8 - ch.feedback))) | 0;
  }

  /**
   * One ordinary two-operator channel.
   *
   * The modulator's output goes into the carrier's phase WHOLE. A full-scale
   * operator is ±4084 and a cycle of phase is 1024 units, so that is ±4 cycles
   * of deviation -- twice what feedback 7 gives, which is the only figure the
   * application manual states. Halving it here to match that figure is what
   * made every FM patch dull, and it survived the ±2042 → ±4084 output-scale
   * fix because the feedback anchor validates the other path; OPL2_NOTES has
   * the measurement.
   */
  #twoOp(ch, tremolo, vibrato) {
    this.#advanceEnvelope(ch.mod);
    this.#advanceEnvelope(ch.car);
    const m = this.#operate(ch.mod, this.#feedbackOf(ch), tremolo, vibrato);
    return ch.additive
      ? m + this.#operate(ch.car, 0, tremolo, vibrato)
      : this.#operate(ch.car, m, tremolo, vibrato);
  }

  /**
   * One four-operator voice: two channels' operators run as one chain.
   *
   * The two channels keep their own CNT bit in register 0xC0, and the four
   * combinations are the four connections the YMF262's published figure draws.
   * Reading CNT as "this half's first operator goes straight to the output
   * instead of modulating" gives all four at once:
   *
   *   0,0   1 → 2 → 3 → 4          0,1   1 → 2 → 3, and 4
   *   1,0   1, and 2 → 3 → 4       1,1   1, and 2 → 3, and 4
   *
   * Feedback belongs to operator 1 only. The slave half's own feedback setting
   * has nowhere to act -- operator 3 is fed by the chain, not by itself -- so
   * it is ignored, which is also what the register layout implies.
   */
  #fourOp(head, tremolo, vibrato) {
    const slave = this.channels[head.pairWith];
    const op1 = head.mod, op2 = head.car, op3 = slave.mod, op4 = slave.car;
    this.#advanceEnvelope(op1); this.#advanceEnvelope(op2);
    this.#advanceEnvelope(op3); this.#advanceEnvelope(op4);

    const o1 = this.#operate(op1, this.#feedbackOf(head), tremolo, vibrato);
    if (!head.additive) {
      const o2 = this.#operate(op2, o1, tremolo, vibrato);
      const o3 = this.#operate(op3, o2, tremolo, vibrato);
      return slave.additive
        ? o3 + this.#operate(op4, 0, tremolo, vibrato)
        : this.#operate(op4, o3, tremolo, vibrato);
    }
    const o2 = this.#operate(op2, 0, tremolo, vibrato);
    const o3 = this.#operate(op3, o2, tremolo, vibrato);
    return slave.additive
      ? o1 + o3 + this.#operate(op4, 0, tremolo, vibrato)
      : o1 + this.#operate(op4, o3, tremolo, vibrato);
  }

  /**
   * Render `count` samples into `out` starting at `offset`, at the chip's
   * native rate, as one mono stream. Output is roughly ±1 after the scaling
   * in `#render`.
   *
   * The stereo switches are ignored here rather than mixed down: a voice
   * panned hard left belongs in a mono mix at its full level, which is also
   * exactly what the same song does on a YM3812.
   *
   * @param {Float32Array} out @param {number} offset @param {number} count
   */
  generate(out, offset, count) {
    this.#render(out, null, offset, count);
  }

  /**
   * Render `count` samples as two channels. On a chip without the stereo
   * switches this is the mono stream twice; on an OPL3 in OPL3 mode it is
   * what register 0xC0 bits 4 and 5 ask for.
   *
   * @param {Float32Array} left @param {Float32Array} right
   * @param {number} offset @param {number} count
   */
  generateStereo(left, right, offset, count) {
    if (!this.stereo) {
      this.#render(left, null, offset, count);
      right.set(left.subarray(offset, offset + count), offset);
      return;
    }
    this.#render(left, right, offset, count);
  }

  #busL = 0;
  #busR = 0;

  /** `right` null means one bus and no panning. */
  #render(left, right, offset, count) {
    const stereo = right !== null;
    const order = this.melodicOrder;
    const chans = this.channels;
    for (let n = 0; n < count; n++) {
      const tremolo = TREMOLO_STEPS[this.amDepth] * ENV_TO_LOG *
        triangle(this.lfoPhase % TREMOLO_PERIOD, TREMOLO_PERIOD);
      const vibCents = VIBRATO_CENTS[this.vibDepth] *
        (2 * triangle(this.lfoPhase % VIBRATO_PERIOD, VIBRATO_PERIOD) - 1);
      const vibrato = vibCents === 0 ? 1 : 2 ** (vibCents / 1200);

      this.#busL = 0;
      this.#busR = 0;
      for (let row = 0; row < order.length; row++) {
        const ch = chans[order[row]];
        // A pair's slave half has no output of its own: its two operators are
        // read inside its head's chain, and its meter row stays at rest.
        if (ch.pairRole === PAIR_SLAVE) continue;
        this.#emit(row, ch, ch.pairRole === PAIR_HEAD
          ? this.#fourOp(ch, tremolo, vibrato)
          : this.#twoOp(ch, tremolo, vibrato), stereo);
      }
      if (this.rhythmMode) this.#generateRhythm(tremolo, vibrato, stereo);

      // The chip sums its channels into a 16-bit DAC; scale so that a single
      // full-amplitude operator is about 0.5.
      left[offset + n] = Math.fround(this.#busL / MIX_SCALE);
      if (stereo) right[offset + n] = Math.fround(this.#busR / MIX_SCALE);
      this.egCounter = (this.egCounter + 1) >>> 0;
      this.lfoPhase = (this.lfoPhase + 1) >>> 0;
      // 23-bit LFSR, tapped at 22 and 8 — the chip's own noise for the drums.
      this.noise = ((this.noise >>> 1) |
        (((this.noise ^ (this.noise >>> 14)) & 1) << 22)) >>> 0;
    }
  }

  /**
   * Note one voice's contribution to the mix, and route it.
   *
   * The peak runs on every voice of every sample whether or not anyone is
   * watching, which costs a few per cent of the render; a flag to switch it
   * off would only trade that for a display that can show stale silence.
   */
  #emit(row, ch, value, stereo) {
    const level = value < 0 ? -value : value;
    if (level > this.peaks[row]) this.peaks[row] = level;
    if (!stereo) { this.#busL += value; return; }
    if (ch.left) this.#busL += value;
    if (ch.right) this.#busR += value;
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
   *
   * An OPL3 puts them on the same three channels of the first bank, and its
   * second bank has no rhythm mode of its own.
   */
  /**
   * The five rhythm voices, each summed into the bus TWICE.
   *
   * That doubling is a property of the chip rather than of any voice: in
   * rhythm mode channels 6, 7 and 8 reach the accumulator twice over, so the
   * drums sit 6 dB above where the same operators would sit on a melodic
   * channel. It is reported, and reported as verified against a real YM3812,
   * by every emulator that implements it -- but Yamaha's own manual documents
   * the drums only as tonal advice (§5-4) and says nothing about the mix, so
   * unlike the envelope clock there is no first-party table behind it. What
   * decided it was listening: without it a rhythm-mode song is audibly mild,
   * and every other candidate for that was measured and ruled out first.
   *
   * `value * 2` rather than two calls to `#emit` so that the per-voice meter
   * reports the contribution the voice actually makes to the mix.
   */
  #generateRhythm(tremolo, vibrato, stereo) {
    const ops = this.operators;
    const ch6 = this.channels[6];
    const ch7 = this.channels[7];
    const ch8 = this.channels[8];
    const base = this.rhythmRow;
    const hh = ops[OP_BY_OFFSET[RHYTHM_HH_OP]];
    const sd = ops[OP_BY_OFFSET[RHYTHM_SD_OP]];
    const tom = ops[OP_BY_OFFSET[RHYTHM_TOM_OP]];
    const tc = ops[OP_BY_OFFSET[RHYTHM_TC_OP]];
    for (const op of [ch6.mod, ch6.car, hh, sd, tom, tc]) this.#advanceEnvelope(op);

    const m = this.#operate(ch6.mod, this.#feedbackOf(ch6), tremolo, vibrato);
    this.#emit(base + R_BD, ch6, RHYTHM_MIX * (ch6.additive
      ? m + this.#operate(ch6.car, 0, tremolo, vibrato)
      : this.#operate(ch6.car, m, tremolo, vibrato)), stereo);

    // Tom-tom is a plain sine on channel 9's frequency.
    this.#emit(base + R_TOM, ch8,
      RHYTHM_MIX * this.#operate(tom, 0, tremolo, vibrato), stereo);

    // The remaining three read each other's accumulators, so every phase has
    // to be advanced before any of them is sampled.
    hh.phase = (hh.phase + hh.phaseInc) >>> 0;
    sd.phase = (sd.phase + sd.phaseInc) >>> 0;
    tc.phase = (tc.phase + tc.phaseInc) >>> 0;
    const hp = (hh.phase >>> 10) & 0x3ff;
    const tp = (tc.phase >>> 10) & 0x3ff;
    const noise = this.noise & 1;
    const xor = (((hp >> 2) ^ (hp >> 7)) | (hp >> 3) | ((tp >> 5) ^ (tp >> 3))) & 1;

    this.#emit(base + R_HH, ch7, RHYTHM_MIX *
      this.#rhythmOperator(hh, (xor << 9) | (xor ^ noise ? 0x0d0 : 0x034), tremolo), stereo);
    this.#emit(base + R_SD, ch7, RHYTHM_MIX *
      this.#rhythmOperator(sd, (((hp >> 8) & 1) ? 0x200 : 0x100) ^ (noise << 8), tremolo), stereo);
    this.#emit(base + R_TC, ch8, RHYTHM_MIX *
      this.#rhythmOperator(tc, (xor << 9) | 0x100, tremolo), stereo);
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
  // to the point on an FM chip anyway.

  /** Chip-wide switches, as the CF_* bits. */
  get chipFlags() {
    return (this.rhythmMode ? CF_RHYTHM : 0) | (this.amDepth ? CF_TREMOLO : 0) |
      (this.vibDepth ? CF_VIBRATO : 0) | (this.waveSelectEnabled ? CF_WAVESEL : 0) |
      (this.opl3 && this.newMode ? CF_OPL3 : 0) |
      (this.fourOpBits && this.opl3 && this.newMode ? CF_FOUROP : 0);
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
    const order = this.melodicOrder;
    for (let row = 0; row < order.length; row++) {
      const ch = this.channels[order[row]];
      if (ch.pairRole === PAIR_SLAVE) continue;      // absorbed into its head
      this.#meterChannel(out, row, ch);
    }
    if (this.rhythmMode) {
      const base = this.rhythmRow;
      const bits = this.rhythmBits;
      const ops = this.operators;
      this.#meterChannel(out, base + R_BD, this.channels[6], (bits & RHYTHM_BD) !== 0);
      // The other four are one operator each. Only the tom is tonal: the
      // hi-hat, snare and cymbal build their phase out of bits of each
      // other's accumulators, so their channel's F-number is not a pitch and
      // reporting it as one would invent a note nobody is playing.
      const tomNote = this.#noteOf(this.channels[8]);
      const ch7 = this.channels[7], ch8 = this.channels[8];
      this.#meterOperator(out, base + R_SD, ops[OP_BY_OFFSET[RHYTHM_SD_OP]], bits & RHYTHM_SD, -1, ch7);
      this.#meterOperator(out, base + R_TOM, ops[OP_BY_OFFSET[RHYTHM_TOM_OP]], bits & RHYTHM_TOM, tomNote, ch8);
      this.#meterOperator(out, base + R_TC, ops[OP_BY_OFFSET[RHYTHM_TC_OP]], bits & RHYTHM_TC, -1, ch8);
      this.#meterOperator(out, base + R_HH, ops[OP_BY_OFFSET[RHYTHM_HH_OP]], bits & RHYTHM_HH, -1, ch7);
    }
    this.peaks.fill(0);
    return out;
  }

  #meterChannel(out, row, ch, keyOn = ch.keyOn) {
    const o = row * METER_STRIDE;
    const four = ch.pairRole === PAIR_HEAD;
    const slave = four ? this.channels[ch.pairWith] : null;
    // What a listener hears is the operator at the end of the chain, and what
    // shapes it is the one at the start. On a four-operator voice those are
    // two channels apart.
    const output = four ? slave.car : ch.car;
    out[o + M_PEAK] = this.peaks[row] / MIX_SCALE;
    out[o + M_MOD_DB] = this.#attenuationDb(ch.mod);
    out[o + M_NOTE] = this.#noteOf(ch);
    out[o + M_KEY_ON] = keyOn ? 1 : 0;
    out[o + M_STATE] = output.state;
    out[o + M_TIMBRE] = (output.wave << T_CAR_WAVE) | (ch.mod.wave << T_MOD_WAVE) |
      ((ch.additive ? 1 : 0) << T_ADDITIVE) | (ch.feedback << T_FEEDBACK) |
      ((four ? 1 : 0) << T_FOUROP) | ((four && slave.additive ? 1 : 0) << T_CONN2);
    out[o + M_PAN] = this.#panOf(ch);
  }

  #meterOperator(out, row, op, keyOn, note, ch) {
    const o = row * METER_STRIDE;
    out[o + M_PEAK] = this.peaks[row] / MIX_SCALE;
    out[o + M_MOD_DB] = -1;                    // one operator: nothing modulates it
    out[o + M_NOTE] = note;
    out[o + M_KEY_ON] = keyOn ? 1 : 0;
    out[o + M_STATE] = op.state;
    out[o + M_TIMBRE] = op.wave << T_CAR_WAVE;
    out[o + M_PAN] = this.#panOf(ch);
  }

  /** The channel's stereo switches, or plain centre on a chip without them. */
  #panOf(ch) {
    if (!this.stereo) return PAN_CENTRE;
    return (ch.left ? 1 : 0) | (ch.right ? 2 : 0);
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

/**
 * A YM3812: nine channels, one output, four waveforms.
 */
export class OPL2 extends OplChip {
  constructor() { super({ opl3: false }); }
}

/**
 * A YMF262: eighteen channels in two register banks, two outputs, eight
 * waveforms, and six channel pairs that can be joined into four-operator
 * voices.
 *
 * It comes up as a YM3812 and stays one until register 0x105 bit 0 is set --
 * which is the chip's own behaviour, not a convenience here, and is what lets
 * an unmodified AdLib driver work on an OPL3 card.
 */
export class OPL3 extends OplChip {
  constructor() { super({ opl3: true }); }
}
