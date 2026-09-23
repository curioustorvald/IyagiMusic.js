// The AdLib low-level driver: patches, volumes, notes and bends in, OPL
// register writes out. This is a straight realisation of
// docs/ENGINE_SPEC.en.md; section numbers below refer to it.
//
// The driver holds no chip of its own -- it writes into any object with a
// `write(reg, value)` method -- so the same code drives the emulator, a test
// double that logs writes, or real hardware over a serial bridge.
//
// It drives a YM3812 or a YMF262, and the difference is smaller than it looks:
// an OPL3 is the same nine channels twice, at `reg | 0x100`, so every table
// below is the OPL2's table with a second copy appended. What is genuinely new
// is in §10 and §11 -- four-operator voices and the stereo switches.

import {
  FNUM_TABLE, SEMITONES, SUBSTEPS, SOP_FNUM_TABLE, SOP_PITCH_STEPS,
} from "./fnum-table.js";
import {
  CHANNEL_COUNT, OPL3_CHANNEL_COUNT, BANK_STRIDE, REG_FOUROP, REG_OPL3_ENABLE,
  OPL3_NEW, FOUROP_PAIRS, PAN_CENTRE, PAN_LEFT, PAN_RIGHT, PAN_SHIFT, RHYTHM_VOICES,
} from "./opl/constants.js";

/** §5.2: MIDI note 60 is chip note 48. */
export const MIDI_TO_CHIP = 12;
export const CHIP_NOTES = 96;
export const MID_PITCH = 0x2000;
export const MAX_VOLUME = 127;

/**
 * §1: logical voice numbers of the five rhythm instruments **on an OPL2**.
 *
 * The rhythm voices always come last, so on an OPL3 they are 15…19 instead.
 * `driver.rhythmBase` is where they start and `driver.bd`…`driver.hh` name
 * them on whichever chip the driver is actually driving; these constants stay
 * because nine-voice callers are the common case and 6…10 is what they mean.
 */
export const BD = 6, SD = 7, TOM = 8, TC = 9, HH = 10;

/**
 * §11.1: IMPLAY's fixed pan per channel, 0x40 centre, lower is further left.
 * Set when a song loads and never moved by it; the song has no say.
 */
export const IMPLAY_PAN = Object.freeze([
  0x45, 0x38, 0x1f, 0x12, 0x53, 0x6a, 0x5c, 0x3d, 0x51, 0x17, 0x72,
]);

/**
 * §11.1: split a channel volume into IMPLAY's two sides by its pan.
 * @param {number} volume 0..127 @param {number} pan 0..127, 0x40 centre
 * @returns {[number, number]} `[right, left]` -- bank 0's level, then bank 1's
 */
export function implaySplit(volume, pan) {
  let right = volume, left = volume;
  if (pan < 0x40) right -= ((0x40 - pan) * volume) >> 6;
  if (pan > 0x40) left -= ((pan - 0x40) * volume) >> 6;
  return [right, left];
}
const RHYTHM_MASK = [0x10, 0x08, 0x04, 0x02, 0x01];   // BD, SD, TOM, TC, HH

/** §6: the tom starts two octaves below chip middle C, the snare 7 above it. */
const TOM_PITCH = 24;
const TOM_TO_SD = 7;

/** §1: register offset of each operator, by slot number, within one bank. */
const SLOT_OFFSET = [
  0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 16, 17, 18, 19, 20, 21,
];
/** §1: the two slots of each melodic channel. */
const MELODIC_SLOTS = [
  [0, 3], [1, 4], [2, 5], [6, 9], [7, 10], [8, 11], [12, 15], [13, 16], [14, 17],
];
/** §6: the rhythm voices' slots -- 255 means the voice uses one operator only. */
const RHYTHM_SLOTS = [
  [12, 15],      // bass drum, channel 6, two operators like any melodic voice
  [16, 255],     // snare     channel 7 carrier
  [14, 255],     // tom-tom   channel 8 modulator
  [17, 255],     // cymbal    channel 8 carrier
  [13, 255],     // hi-hat    channel 7 modulator
];
const SLOT_IS_CARRIER = [
  0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 1,
];
/** §1: which channel of its bank an operator slot physically belongs to. */
const SLOT_CHANNEL = [
  0, 1, 2, 0, 1, 2, 3, 4, 5, 3, 4, 5, 6, 7, 8, 6, 7, 8,
];
const SLOTS_PER_BANK = 18;

/** The thirteen per-operator parameters, in bank order. §2.3 of the formats doc. */
const P_KSL = 0, P_MULTIPLE = 1, P_FEEDBACK = 2, P_ATTACK = 3, P_SUSTAIN = 4,
  P_EG = 5, P_DECAY = 6, P_RELEASE = 7, P_LEVEL = 8, P_AM = 9, P_VIB = 10,
  P_KSR = 11, P_CONNECTION = 12;

const FIELD_ORDER = [
  "ksl", "multiple", "feedback", "attack", "sustain", "eg",
  "decay", "release", "totalLevel", "am", "vib", "ksr", "connection",
];

/** Flatten a parsed bank operator into the driver's parameter array. */
function operatorParams(op) {
  const out = new Int32Array(13);
  for (let i = 0; i < 13; i++) out[i] = op[FIELD_ORDER[i]] | 0;
  return out;
}

/** Where a slot's four-operator chain puts it: op1, op2, op3 or op4. */
const OP1 = 0, OP2 = 1, OP3 = 2, OP4 = 3, NOT_FOUR = -1;

/**
 * §1, §10. The voice layouts of a chip. They depend on nothing but which chip
 * it is, so they are built once and shared -- `sopSequence` has to know the
 * shape of a chip's voices before a driver exists to ask.
 *
 * Both layouts follow one rule: melodic voices in channel order, then -- in
 * percussive mode -- the five rhythm instruments on the end, which take over
 * channels 6, 7 and 8 of the first bank. Nine channels give 9 voices or 6 + 5;
 * eighteen give 18 or 15 + 5. The rhythm voices are the last five either way,
 * which is what lets a display index a meter row with a voice number without
 * knowing which chip it is looking at.
 *
 * @param {boolean} opl3
 */
function makeLayout(opl3) {
  const banks = opl3 ? 2 : 1;
  const channelCount = opl3 ? OPL3_CHANNEL_COUNT : CHANNEL_COUNT;
  const slotCount = banks * SLOTS_PER_BANK;

  const melodicSlots = [], melodicChannel = [];
  for (let b = 0; b < banks; b++) {
    for (let c = 0; c < CHANNEL_COUNT; c++) {
      melodicSlots.push(MELODIC_SLOTS[c].map((slot) => slot + b * SLOTS_PER_BANK));
      melodicChannel.push(c + b * CHANNEL_COUNT);
    }
  }
  const melodicMap = { slots: melodicSlots, channel: melodicChannel };

  // Percussive mode: the first bank loses channels 6, 7 and 8 to the drums,
  // the second bank keeps all nine, and the drums go on the end.
  const percSlots = [], percChannel = [];
  for (let c = 0; c < 6; c++) { percSlots.push(melodicSlots[c]); percChannel.push(c); }
  for (let c = CHANNEL_COUNT; c < channelCount; c++) {
    percSlots.push(melodicSlots[c]); percChannel.push(melodicChannel[c]);
  }
  const rhythmBase = percSlots.length;
  for (const slots of RHYTHM_SLOTS) percSlots.push(slots);
  percChannel.push(6, 7, 8, 8, 7);
  const percussiveMap = { slots: percSlots, channel: percChannel };

  // A slot's channel never moves; only which voice is using it does.
  const slotChannel = new Int32Array(slotCount);
  const slotCarrier = new Int32Array(slotCount);
  const slotRegister = new Int32Array(slotCount);
  for (let s = 0; s < slotCount; s++) {
    const local = s % SLOTS_PER_BANK, bank = (s / SLOTS_PER_BANK) | 0;
    slotChannel[s] = SLOT_CHANNEL[local] + bank * CHANNEL_COUNT;
    slotCarrier[s] = SLOT_IS_CARRIER[local];
    slotRegister[s] = SLOT_OFFSET[local] + bank * BANK_STRIDE;
  }

  // §10: only six channel pairs can be joined, and only ever a channel with
  // the one three above it in the same bank. Translating those channel pairs
  // into voice numbers is all this does; in melodic mode voice and channel are
  // the same number, and in percussive mode the second bank has been shifted
  // down by the three channels the drums took.
  for (const map of [melodicMap, percussiveMap]) {
    const index = new Int32Array(map.slots.length).fill(-1);
    const partner = new Int32Array(map.slots.length).fill(-1);
    const pairs = [];
    if (opl3) {
      FOUROP_PAIRS.forEach(([headCh, slaveCh], i) => {
        const head = map.channel.indexOf(headCh), slave = map.channel.indexOf(slaveCh);
        if (head < 0 || slave < 0) return;
        index[head] = i;
        partner[head] = slave;
        partner[slave] = head;
        pairs.push([head, slave]);
      });
    }
    map.four = { index, partner, pairs };
    // Slot -> voice, which the layout fixes. Only the four-operator override
    // on top of it moves, and `#voiceOfSlot` applies that.
    map.voiceOfSlot = new Int32Array(slotCount).fill(-1);
    map.slots.forEach((slots, v) => {
      for (const slot of slots) if (slot !== 255) map.voiceOfSlot[slot] = v;
    });
  }

  return {
    opl3, banks, channelCount, slotCount, rhythmBase,
    melodicMap, percussiveMap, slotChannel, slotCarrier, slotRegister,
  };
}

const LAYOUTS = [makeLayout(false), makeLayout(true)];

/** The shared layout of a YM3812 or a YMF262. @param {boolean} opl3 */
export function chipLayout(opl3) { return LAYOUTS[opl3 ? 1 : 0]; }

/**
 * What a sequencer needs to know about a chip's voices before it can lay a
 * song over them: how many melodic ones there are, where the drums start, and
 * which voices can be joined into four-operator ones.
 *
 * @param {boolean} opl3 @param {boolean} percussive
 * @returns {{melodicVoices:number, rhythmBase:number, fourOpPairs:number[][], voiceCount:number}}
 */
export function voiceLayout(opl3, percussive) {
  const layout = chipLayout(opl3);
  const map = percussive ? layout.percussiveMap : layout.melodicMap;
  return {
    melodicVoices: percussive ? layout.rhythmBase : map.slots.length,
    rhythmBase: layout.rhythmBase,
    fourOpPairs: map.four.pairs,
    voiceCount: map.slots.length,
  };
}

export class AdlibDriver {
  /**
   * @param {{write(reg:number, value:number):void}} chip
   * @param {object} [options]
   * @param {boolean} [options.opl3] drive a YMF262: two banks, eighteen
   *   channels, four-operator voices and stereo. Default false, which is a
   *   YM3812 and is what `.ims` and `.rol` want.
   * @param {boolean} [options.sop] behave as NOTE.EXE's driver does for a
   *   `.sop` (SOP §8.1): bends are SOP pitch values 0..200 on Note's own
   *   F-number table, a joined channel pair stays joined when it is given a
   *   two-operator patch, and a corrupt pan value corrupts 0xC0. Default false.
   * @param {boolean} [options.mirror] play the nine-channel layout the way
   *   IMPLAY does on a YMF262 (§11.1): every melodic channel twice, once per
   *   register bank, bank 0 on the right and bank 1 on the left, with the
   *   levels split by `IMPLAY_PAN`. The chip must be an OPL3; `opl3` must be
   *   false, because the voices are still the YM3812's nine. Default false.
   */
  constructor(chip, options = {}) {
    this.chip = chip;
    /** @type {boolean} */
    this.opl3 = !!options.opl3;
    /** @type {boolean} */
    this.sop = !!options.sop;
    /** @type {boolean} */
    this.mirror = !!options.mirror && !this.opl3;
    /**
     * Mirror mode: whether the two banks get IMPLAY's panned levels (true) or
     * the same level each (false). The second is mono, sample for sample what
     * a YM3812 plays, and is what lets a listener switch between the two
     * mid-song without reloading anything. See `setMirrorPanning`.
     * @type {boolean}
     */
    this.mirrorPanning = true;
    const layout = chipLayout(this.opl3);
    this.banks = layout.banks;
    this.channelCount = layout.channelCount;
    this.slotCount = layout.slotCount;
    /** @type {number} the voice number of the bass drum: 6 here, 15 on an OPL3 */
    this.rhythmBase = layout.rhythmBase;
    this.melodicMap = layout.melodicMap;
    this.percussiveMap = layout.percussiveMap;
    this.slotChannel = layout.slotChannel;
    this.slotCarrier = layout.slotCarrier;
    this.slotRegister = layout.slotRegister;
    /** §1: the five rhythm voices, on whichever chip this is. */
    this.bd = this.rhythmBase;
    this.sd = this.rhythmBase + 1;
    this.tom = this.rhythmBase + 2;
    this.tc = this.rhythmBase + 3;
    this.hh = this.rhythmBase + 4;
    this.slotParams = Array.from({ length: this.slotCount }, () => new Int32Array(14));
    this.reset();
  }

  /** §2. Leaves the chip in melodic mode with every voice at full volume. */
  reset() {
    // NEW first: until it is set, a YMF262 ignores its second bank, so zeroing
    // the bank before setting it would zero nothing.
    if (this.opl3 || this.mirror) this.chip.write(REG_OPL3_ENABLE, OPL3_NEW);
    for (let b = 0; b < (this.mirror ? 2 : this.banks); b++) {
      const base = b * BANK_STRIDE;
      for (let r = 1; r <= 0xf5; r++) {
        const reg = base + r;
        if (reg === REG_FOUROP || reg === REG_OPL3_ENABLE) continue;
        this.chip.write(reg, 0);
      }
    }
    this.chip.write(0x04, 0x06);
    if (this.opl3) this.chip.write(REG_FOUROP, 0);

    this.voiceNote = new Int32Array(this.channelCount + RHYTHM_VOICES);
    this.voiceKeyOn = new Int32Array(this.channelCount + RHYTHM_VOICES);
    this.voiceBend = new Int32Array(this.channelCount + RHYTHM_VOICES).fill(MID_PITCH);
    this.bxCache = new Int32Array(this.channelCount + RHYTHM_VOICES);
    /** @type {Int32Array} per-voice volume 0..127, wide enough for rhythm mode */
    this.voiceVolume = new Int32Array(this.channelCount + RHYTHM_VOICES).fill(MAX_VOLUME);
    /** @type {Int32Array} 1 where a voice is currently four operators wide */
    this.voiceFourOp = new Int32Array(this.channelCount + RHYTHM_VOICES);
    /**
     * SOP mode: 1 where a voice is a joined pair carrying a two-operator
     * patch. Note loads such a patch into the first pair and leaves the
     * second as it was, still joined (SOP §3.3); from then on only the first
     * pair is the voice's for loading, volume and panning.
     * @type {Int32Array}
     */
    this.voiceHalf = new Int32Array(this.channelCount + RHYTHM_VOICES);
    /** @type {Int32Array} SOP mode: each voice's pitch, 0..200 about 100 */
    this.voiceSopPitch = new Int32Array(this.channelCount + RHYTHM_VOICES).fill(100);
    /** @type {number} */
    this.percBits = 0;
    /** @type {boolean} */
    this.percussion = false;
    /** @type {number} 9 or 11 on an OPL2; 18 or 20 on an OPL3 */
    this.voiceCount = this.melodicMap.slots.length;
    /** @type {number} */
    this.amDepth = 0;
    /** @type {number} */
    this.vibDepth = 0;
    /** @type {number} */
    this.noteSelect = 0;
    /** @type {number} */
    this.pitchRange = 1;
    /** @type {boolean} */
    this.waveSelect = true;
    /** @type {number} register 0x104, one bit per pair of FOUROP_PAIRS */
    this.fourOpBits = 0;
    for (const p of this.slotParams) p.fill(0);

    // §11: a YMF262 comes up with both stereo switches clear, which is silence
    // rather than mono. Writing centre to every channel is what makes a driver
    // that never thinks about panning sound the same on both chips.
    this.channelPan = new Int32Array(this.channelCount).fill(PAN_CENTRE);
    this.channelC0 = new Int32Array(this.channelCount);
    /**
     * SOP mode: feedback/connection bits a corrupt pan value has ORed into
     * 0xC0, which stay until the channel's next patch. SOP §4.2.
     * @type {Int32Array}
     */
    this.channelC0Or = new Int32Array(this.channelCount);
    if (this.opl3 || this.mirror) for (let c = 0; c < this.channelCount; c++) this.#writeC0(c);

    this.setMode(false);
    this.setGlobalParams(0, 0, 0);
    this.setPitchRange(1);
    this.setWaveSelect(true);
  }

  /** §6. `percussive` true puts the chip in rhythm mode. @param {boolean} percussive */
  setMode(percussive) {
    if (percussive) {
      this.percussion = true;              // slot maps must already be percussive
      this.voiceCount = this.percussiveMap.slots.length;
      this.voiceNote[this.tom] = TOM_PITCH;
      this.voiceBend[this.tom] = MID_PITCH;
      this.#updateFNums(this.tom);
      this.voiceNote[this.sd] = TOM_PITCH + TOM_TO_SD;
      this.voiceBend[this.sd] = MID_PITCH;
      this.#updateFNums(this.sd);
    }
    this.percussion = percussive;
    this.voiceCount = percussive
      ? this.percussiveMap.slots.length : this.melodicMap.slots.length;
    this.percBits = 0;
    // §10: the two modes number their voices differently, so a four-operator
    // flag set under one of them means something else under the other. Split
    // every pair rather than carry the flags across.
    if (this.opl3 && this.fourOpBits) {
      this.fourOpBits = 0;
      this.voiceFourOp.fill(0);
      this.chip.write(REG_FOUROP, 0);
    }
    this.#sendAmVibRhythm();
    // §11.1: in mirror mode channels 6..8 are routed by what they are. As
    // drums they play on bank 0 alone, to both sides; as melodic channels,
    // bank 0 is the right.
    if (this.mirror) for (let c = 6; c < CHANNEL_COUNT; c++) this.#writeC0(c);
  }

  /**
   * Mirror mode: IMPLAY's panned levels, or the same level on both banks.
   * Takes effect at once, on every voice. Ignored outside mirror mode.
   * @param {boolean} on
   */
  setMirrorPanning(on) {
    if (!this.mirror || this.mirrorPanning === !!on) return;
    this.mirrorPanning = !!on;
    for (let s = 0; s < this.slotCount; s++) this.#sendKslLevel(s);
  }

  /** @param {boolean} on */
  setWaveSelect(on) {
    this.waveSelect = !!on;
    for (let s = 0; s < this.slotCount; s++) this.#writeSlot(0xe0, s, 0);
    this.chip.write(0x01, on ? 0x20 : 0);
  }

  /** §5.2. Clamped into 1…12 semitones, as the driver does. @param {number} semitones */
  setPitchRange(semitones) {
    this.pitchRange = Math.min(12, Math.max(1, semitones | 0));
  }

  /**
   * @param {number} amDepth @param {number} vibDepth @param {number} noteSelect
   */
  setGlobalParams(amDepth, vibDepth, noteSelect) {
    this.amDepth = amDepth; this.vibDepth = vibDepth; this.noteSelect = noteSelect;
    this.#sendAmVibRhythm();
    this.chip.write(0x08, noteSelect ? 0x40 : 0);
  }

  /** The voice numbers a song may use as ordinary melodic voices. §1. */
  get melodicVoices() {
    return this.percussion ? this.rhythmBase : this.voiceCount;
  }

  /**
   * §10. Voice-number pairs that can be joined into one four-operator voice,
   * in the current mode. Empty on an OPL2.
   * @returns {number[][]}
   */
  get fourOpPairs() {
    return this.#map().four.pairs;
  }

  /** §3. Load a parsed bank patch into a voice.
   *
   * A patch carrying a second operator pair (SOP §3.3) is loaded as a
   * four-operator voice where the voice can be one, and as its first pair
   * alone where it cannot -- which is the whole of the OPL2 degradation, in
   * one branch.
   *
   * In SOP mode the patch does not decide the join; `join` does, when it is
   * given, and otherwise the pair stays as it is. A four-operator patch on a
   * voice that is not joined loads its first pair, and a two-operator patch
   * on one that is loads the first pair and leaves the second alone -- both as
   * NOTE.EXE does (SOP §3.3).
   *
   * @param {number} voice @param {import("./formats.js").Patch} patch
   * @param {boolean} [join] SOP mode: whether the voice's channel pair is joined
   */
  setVoiceTimbre(voice, patch, join) {
    if (voice >= this.voiceCount) return;
    const map = this.#map();
    const pairIndex = map.four.index[voice];
    let four;
    if (this.sop) {
      if (pairIndex >= 0 && join !== undefined) this.#setFourOp(pairIndex, voice, !!join);
      const joined = pairIndex >= 0 && !!this.voiceFourOp[voice];
      four = joined && !!patch.pair;
      this.voiceHalf[voice] = joined && !patch.pair ? 1 : 0;
    } else {
      four = pairIndex >= 0 && !!patch.pair;
      // Joining or splitting the pair before loading it: the chip reads four
      // operators as one voice only while 0x104 says so.
      if (pairIndex >= 0) this.#setFourOp(pairIndex, voice, four);
    }

    const slots = this.#slotsOf(voice);
    this.#setSlot(slots[0], operatorParams(patch.modulator), patch.modWave);
    if (slots[1] !== 255) {
      this.#setSlot(slots[1], operatorParams(patch.carrier), patch.carWave);
    }
    if (four) {
      const partner = this.#slotsOf(map.four.partner[voice]);
      this.#setSlot(partner[0], operatorParams(patch.pair.modulator), patch.pair.modWave);
      this.#setSlot(partner[1], operatorParams(patch.pair.carrier), patch.pair.carWave);
      // §10: all four operators are one voice at one pitch, and the chip reads
      // the head's F-number. Writing it to both halves keeps the two readings
      // of that from being distinguishable.
      this.#updateFNums(voice);
      // Which operators channel volume applies to depends on *both* halves'
      // connection bits, so the first pair's levels were computed against the
      // second pair's previous patch. Send all four again now they agree.
      for (const slot of this.#allSlotsOf(voice)) this.#sendKslLevel(slot);
    }
  }

  /** §4. Channel volume, 0…127.
   * @param {number} voice @param {number} volume 0..127
   */
  setVoiceVolume(voice, volume) {
    if (voice >= this.voiceCount) return;
    this.voiceVolume[voice] = Math.min(MAX_VOLUME, volume | 0);
    for (const slot of this.#allSlotsOf(voice)) this.#sendKslLevel(slot);
  }

  /**
   * §11. Route a voice to the left output, the right, both or neither, as the
   * PAN_* values. An OPL2 has one output and ignores this.
   *
   * `garble` is SOP mode's: the low nibble of a pan value Note did not
   * recognise, which it ORs into the channel's feedback and connection bits
   * until the next patch (SOP §4.2). It reaches an OPL2 too, which has no
   * stereo switches but does have feedback.
   *
   * @param {number} voice @param {number} pan PAN_NONE…PAN_CENTRE
   * @param {number} [garble] SOP mode: bits to OR into 0xC0's low nibble
   */
  setVoicePan(voice, pan, garble = 0) {
    if (voice >= this.voiceCount || (!this.opl3 && !garble)) return;
    const map = this.#map();
    const value = pan & 3;
    // A four-operator voice is two channels, and which of the two carries the
    // output is not worth depending on: both get the same switches. Note,
    // though, pans only the first channel of a pair it has loaded a
    // two-operator patch into, so SOP mode does too.
    const voices = map.four.index[voice] >= 0 && this.voiceFourOp[voice] && !this.voiceHalf[voice]
      ? [voice, map.four.partner[voice]] : [voice];
    for (const v of voices) {
      const channel = map.channel[v];
      if (this.channelPan[channel] === value && !garble) continue;
      this.channelPan[channel] = value;
      this.channelC0Or[channel] |= garble & 0x0f;
      this.#writeC0(channel);
    }
  }

  /** §5. 14-bit bend, 0x2000 is centre. Melodic voices and the bass drum.
   * @param {number} voice @param {number} bend 14-bit, 0x2000 centred
   */
  setVoicePitch(voice, bend) {
    if (this.sop) {
      // SOP §4.2: `bend` is the file's 0..200. Note clamps it at the top and
      // ignores it on every rhythm voice but the bass drum.
      if (this.#isMelodic(voice) || voice === this.bd) {
        this.voiceSopPitch[voice] = Math.min(200, Math.max(0, bend | 0));
        this.#updateFNums(voice);
      }
      return;
    }
    if (this.#isMelodic(voice) || voice === this.bd) {
      this.voiceBend[voice] = Math.min(0x3fff, Math.max(0, bend | 0));
      this.#updateFNums(voice);
    }
  }

  /** §7. `note` is a MIDI note number.
   * @param {number} voice @param {number} note MIDI note number
   */
  noteOn(voice, note) {
    let pitch = note - MIDI_TO_CHIP;
    if (pitch < 0) pitch = 0;
    if (this.#isMelodic(voice)) {
      this.voiceNote[voice] = pitch;
      this.voiceKeyOn[voice] = 0x20;
      this.#updateFNums(voice);
    } else if (this.#isRhythm(voice)) {
      if (voice === this.bd) {
        this.voiceNote[this.bd] = pitch;
        this.#updateFNums(this.bd);
      } else if (voice === this.tom && this.voiceNote[this.tom] !== pitch) {
        // §6: only the tom carries a pitch, and it drags the snare with it.
        this.voiceNote[this.tom] = pitch;
        this.voiceNote[this.sd] = pitch + TOM_TO_SD;
        this.#updateFNums(this.tom);
        this.#updateFNums(this.sd);
      }
      this.percBits |= RHYTHM_MASK[voice - this.rhythmBase];
      this.#sendAmVibRhythm();
    }
  }

  /** §7.
   * @param {number} voice
   */
  noteOff(voice) {
    if (this.#isMelodic(voice)) {
      this.voiceKeyOn[voice] = 0;
      this.bxCache[voice] &= ~0x20;
      this.#writeChannel(0xb0, this.#map().channel[voice], this.bxCache[voice]);
      if (this.voiceFourOp[voice]) {
        this.#writeChannel(0xb0, this.#map().channel[this.#map().four.partner[voice]],
          this.bxCache[voice]);
      }
    } else if (this.#isRhythm(voice)) {
      this.percBits &= ~RHYTHM_MASK[voice - this.rhythmBase];
      this.#sendAmVibRhythm();
    }
  }

  #map() { return this.percussion ? this.percussiveMap : this.melodicMap; }

  /** A voice that takes a note and a pitch of its own, as opposed to a drum. */
  #isMelodic(voice) { return voice >= 0 && voice < this.melodicVoices; }

  #isRhythm(voice) {
    return this.percussion &&
      voice >= this.rhythmBase && voice < this.rhythmBase + RHYTHM_VOICES;
  }

  #slotsOf(voice) { return this.#map().slots[voice]; }

  /** Every operator slot a voice occupies: two, four, or -- a drum -- one. */
  #allSlotsOf(voice) {
    const slots = this.#slotsOf(voice).filter((s) => s !== 255);
    if (!this.voiceFourOp[voice] || this.voiceHalf[voice]) return slots;
    return slots.concat(this.#map().slots[this.#map().four.partner[voice]]);
  }

  /** §10. Join or split one channel pair, and remember which voices are wide. */
  #setFourOp(pairIndex, voice, on) {
    const map = this.#map();
    const partner = map.four.partner[voice];
    const bit = 1 << pairIndex;
    const wanted = on ? (this.fourOpBits | bit) : (this.fourOpBits & ~bit);
    this.voiceFourOp[voice] = on ? 1 : 0;
    this.voiceFourOp[partner] = 0;              // the slave is never a voice itself
    if (!on) this.voiceHalf[voice] = 0;
    if (wanted === this.fourOpBits) return;
    this.fourOpBits = wanted;
    this.chip.write(REG_FOUROP, this.fourOpBits);
  }

  #setSlot(slot, params, waveSel) {
    const p = this.slotParams[slot];
    for (let i = 0; i < 13; i++) p[i] = params[i];
    p[13] = waveSel | 0;
    this.#sendAmVibRhythm();
    this.chip.write(0x08, this.noteSelect ? 0x40 : 0);
    this.#sendKslLevel(slot);
    this.#sendFeedbackConnection(slot);
    this.#sendAttackDecay(slot);
    this.#sendSustainRelease(slot);
    this.#sendAmVibEgKsrMultiple(slot);
    this.#sendWaveSelect(slot);
  }

  /**
   * §4. The three-way condition is the whole point of this routine: channel
   * volume scales the operators that reach the output and leaves the ones that
   * only modulate alone, because scaling a modulator changes the timbre rather
   * than the level.
   *
   * §10 adds the four-operator reading of "reaches the output", which the two
   * halves' connection bits choose between; `#chainPosition` works out which
   * of the four an operator is.
   */
  #sendKslLevel(slot) {
    const p = this.slotParams[slot];
    const voice = this.#voiceOfSlot(slot);
    const level = 63 - (p[P_LEVEL] & 63);
    const ksl = (p[P_KSL] & 3) << 6;
    const scale = (volume) => (level * volume + (MAX_VOLUME + 1) / 2) >> 7;
    if (!this.#isOutputSlot(slot, voice)) {
      this.#writeSlot(0x40, slot, (63 - level) | ksl);
      return;
    }
    const volume = this.voiceVolume[voice];
    if (!this.#mirrored(slot)) {
      this.chip.write(0x40 + this.slotRegister[slot], (63 - scale(volume)) | ksl);
      return;
    }
    // §11.1: the same voice at two levels, one per bank; centred when the
    // listener has asked for mono.
    const [right, left] = this.mirrorPanning
      ? implaySplit(volume, IMPLAY_PAN[voice] ?? 0x40) : [volume, volume];
    this.chip.write(0x40 + this.slotRegister[slot], (63 - scale(right)) | ksl);
    this.chip.write(0x140 + this.slotRegister[slot], (63 - scale(left)) | ksl);
  }

  /**
   * Mirror mode: whether a slot is doubled onto the second bank -- which
   * every melodic channel's slots are, and the drums' are not (§11.1).
   */
  #mirrored(slot) {
    if (!this.mirror) return false;
    return !(this.percussion && this.slotChannel[slot] >= 6);
  }

  /** An operator register, in bank 0 and, if it is mirrored, in bank 1 too. */
  #writeSlot(base, slot, value) {
    this.chip.write(base + this.slotRegister[slot], value);
    if (this.#mirrored(slot)) this.chip.write(0x100 + base + this.slotRegister[slot], value);
  }

  /** Whether channel volume applies to this operator. §4, §10. */
  #isOutputSlot(slot, voice) {
    const position = this.#chainPosition(slot, voice);
    if (position === NOT_FOUR) {
      const singleSlot = this.percussion && voice > this.bd;
      return !!this.slotCarrier[slot] || !this.slotParams[slot][P_CONNECTION] || singleSlot;
    }
    // §10: reading each half's connection bit as "this half's first operator
    // goes straight to the output" names the outputs of all four connections.
    const map = this.#map();
    const head = this.#slotsOf(voice);
    const slave = this.#slotsOf(map.four.partner[voice]);
    const cnt1 = !this.slotParams[head[0]][P_CONNECTION];
    const cnt2 = !this.slotParams[slave[0]][P_CONNECTION];
    switch (position) {
      case OP1: return cnt1;
      case OP2: return false;
      case OP3: return cnt2;
      default: return true;                     // OP4 is always an output
    }
  }

  /** Where a slot sits in its voice's four-operator chain, if it is in one. */
  #chainPosition(slot, voice) {
    if (voice < 0 || !this.voiceFourOp[voice] || this.voiceHalf[voice]) return NOT_FOUR;
    const map = this.#map();
    const head = this.#slotsOf(voice);
    const slave = this.#slotsOf(map.four.partner[voice]);
    if (slot === head[0]) return OP1;
    if (slot === head[1]) return OP2;
    if (slot === slave[0]) return OP3;
    if (slot === slave[1]) return OP4;
    return NOT_FOUR;
  }

  /** Which voice is currently using a slot, or -1 while none is. */
  #voiceOfSlot(slot) {
    const map = this.#map();
    const v = map.voiceOfSlot[slot];
    if (v < 0) return -1;
    // The slave half of a joined pair belongs to its head's voice: that is
    // whose volume and whose patch it is carrying.
    const partner = map.four.partner[v];
    return partner >= 0 && this.voiceFourOp[partner] ? partner : v;
  }

  #sendFeedbackConnection(slot) {
    if (this.slotCarrier[slot]) return;
    const p = this.slotParams[slot];
    const channel = this.slotChannel[slot];
    this.channelC0[channel] = ((p[P_FEEDBACK] & 7) << 1) | (p[P_CONNECTION] ? 0 : 1);
    this.channelC0Or[channel] = 0;              // a new patch clears a bad pan's damage
    this.#writeC0(channel);
  }

  /** §11. One channel's 0xC0: feedback and connection, plus the stereo bits. */
  #writeC0(channel) {
    const bits = this.channelC0[channel] | this.channelC0Or[channel];
    if (this.mirror) {
      // §11.1: IMPLAY writes 0xA0 to bank 0 and 0x50 to bank 1 -- outputs
      // B+D and A+C, which on a Sound Blaster's wiring are right and left --
      // and 0xF0, everything, to a drum channel. Only A and B exist here.
      if (this.percussion && channel >= 6) {
        this.chip.write(0xc0 + channel, bits | (PAN_CENTRE << PAN_SHIFT));
        return;
      }
      this.chip.write(0xc0 + channel, bits | (PAN_RIGHT << PAN_SHIFT));
      this.chip.write(0x1c0 + channel, bits | (PAN_LEFT << PAN_SHIFT));
      return;
    }
    const pan = this.opl3 ? (this.channelPan[channel] & 3) << PAN_SHIFT : 0;
    this.#writeChannel(0xc0, channel, bits | pan);
  }

  #sendAttackDecay(slot) {
    const p = this.slotParams[slot];
    this.#writeSlot(0x60, slot,
      ((p[P_ATTACK] & 0x0f) << 4) | (p[P_DECAY] & 0x0f));
  }

  #sendSustainRelease(slot) {
    const p = this.slotParams[slot];
    this.#writeSlot(0x80, slot,
      ((p[P_SUSTAIN] & 0x0f) << 4) | (p[P_RELEASE] & 0x0f));
  }

  #sendAmVibEgKsrMultiple(slot) {
    const p = this.slotParams[slot];
    const value = (p[P_AM] ? 0x80 : 0) | (p[P_VIB] ? 0x40 : 0) |
      (p[P_EG] ? 0x20 : 0) | (p[P_KSR] ? 0x10 : 0) | (p[P_MULTIPLE] & 0x0f);
    this.#writeSlot(0x20, slot, value);
  }

  /**
   * §3. An OPL3 has eight waveforms and an OPL2 four, so the patch's own
   * setting is masked by what the chip can reach rather than by what the file
   * happens to hold. A `.sop` stores OPL3 wave selects (SOP §3.2); on a YM3812
   * they become whichever of the first four share their low two bits.
   */
  #sendWaveSelect(slot) {
    const mask = this.opl3 ? 7 : 3;
    const wave = this.waveSelect ? this.slotParams[slot][13] & mask : 0;
    this.#writeSlot(0xe0, slot, wave);
  }

  #sendAmVibRhythm() {
    const value = (this.amDepth ? 0x80 : 0) | (this.vibDepth ? 0x40 : 0) |
      (this.percussion ? 0x20 : 0) | this.percBits;
    this.chip.write(0xbd, value);
  }

  /**
   * A per-channel register, in whichever bank the channel lives -- and, for a
   * melodic channel in mirror mode, in the second bank as well (§11.1).
   */
  #writeChannel(base, channel, value) {
    const bank = channel >= CHANNEL_COUNT ? BANK_STRIDE : 0;
    this.chip.write(base + (channel % CHANNEL_COUNT) + bank, value);
    if (this.mirror && !(this.percussion && channel >= 6)) {
      this.chip.write(base + channel + BANK_STRIDE, value);
    }
  }

  /** §5.2. */
  #updateFNums(voice) {
    this.bxCache[voice] = this.#setFreq(
      voice, this.voiceNote[voice], this.voiceBend[voice], this.voiceKeyOn[voice]);
  }

  #setFreq(voice, note, bend, keyOn) {
    if (this.sop) return this.#setFreqSop(voice, note, keyOn);
    const bendOffset = ((bend - MID_PITCH) >> 5) * this.pitchRange;
    let t = (note << 8) + bendOffset;
    t = (t + 8) >> 4;
    const limit = CHIP_NOTES * SUBSTEPS - 1;
    if (t < 0) t = 0; else if (t > limit) t = limit;

    const semitone = t >> 4;
    const sixteenth = t & 15;
    let entry = FNUM_TABLE[(semitone % SEMITONES) * SUBSTEPS + sixteenth];
    let block = ((semitone / SEMITONES) | 0) - 1;
    if (entry & 0x8000) block++;
    if (block < 0) { block++; entry >>= 1; }
    const fnum = entry & 0x3ff;

    const map = this.#map();
    const bx = keyOn | ((block & 7) << 2) | ((fnum >> 8) & 3);
    const channels = this.voiceFourOp[voice]
      ? [map.channel[voice], map.channel[map.four.partner[voice]]]
      : [map.channel[voice]];
    for (const channel of channels) {
      this.#writeChannel(0xa0, channel, fnum & 0xff);
      this.#writeChannel(0xb0, channel, bx);
    }
    return bx;
  }

  /**
   * SOP §4.2: NOTE.EXE's own frequency routine. The pitch, shifted right by
   * two, picks a semitone either way and one of 25 rows of Note's table;
   * the note, plus that semitone, is clamped to the chip's eight octaves.
   */
  #setFreqSop(voice, note, keyOn) {
    const t = this.voiceSopPitch[voice] >> 2;
    let semitone = 0;
    let row = t - SOP_PITCH_STEPS;
    if (row < 0) { semitone = -1; row = t; } else if (row >= SOP_PITCH_STEPS) {
      semitone = 1; row -= SOP_PITCH_STEPS;
    }
    let n = note + semitone;
    if (n < 0) n = 0; else if (n > CHIP_NOTES - 1) n = CHIP_NOTES - 1;
    const fnum = SOP_FNUM_TABLE[row * SEMITONES + (n % SEMITONES)];
    const block = (n / SEMITONES) | 0;

    const map = this.#map();
    const bx = keyOn | ((block & 7) << 2) | ((fnum >> 8) & 3);
    const channels = this.voiceFourOp[voice]
      ? [map.channel[voice], map.channel[map.four.partner[voice]]]
      : [map.channel[voice]];
    for (const channel of channels) {
      this.#writeChannel(0xa0, channel, fnum & 0xff);
      this.#writeChannel(0xb0, channel, bx);
    }
    return bx;
  }
}
