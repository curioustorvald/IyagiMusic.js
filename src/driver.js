// The AdLib low-level driver: patches, volumes, notes and bends in, OPL2
// register writes out. This is a straight realisation of
// docs/ENGINE_SPEC.en.md; section numbers below refer to it.
//
// The driver holds no chip of its own -- it writes into any object with a
// `write(reg, value)` method -- so the same code drives the emulator, a test
// double that logs writes, or real hardware over a serial bridge.

import { FNUM_TABLE, SEMITONES, SUBSTEPS } from "./fnum-table.js";

/** §5.2: MIDI note 60 is chip note 48. */
export const MIDI_TO_CHIP = 12;
export const CHIP_NOTES = 96;
export const MID_PITCH = 0x2000;
export const MAX_VOLUME = 127;

/** §1: logical voice numbers of the five rhythm instruments. */
export const BD = 6, SD = 7, TOM = 8, TC = 9, HH = 10;
const RHYTHM_MASK = [0x10, 0x08, 0x04, 0x02, 0x01];   // BD, SD, TOM, TC, HH

/** §6: the tom starts two octaves below chip middle C, the snare 7 above it. */
const TOM_PITCH = 24;
const TOM_TO_SD = 7;

/** §1: register offset of each operator, by slot number. */
const SLOT_OFFSET = [
  0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 16, 17, 18, 19, 20, 21,
];
/** §1: the two slots of each melodic voice. */
const MELODIC_SLOTS = [
  [0, 3], [1, 4], [2, 5], [6, 9], [7, 10], [8, 11], [12, 15], [13, 16], [14, 17],
];
/** §1: percussive mode -- 255 means the voice uses one operator only. */
const PERCUSSIVE_SLOTS = [
  [0, 3], [1, 4], [2, 5], [6, 9], [7, 10], [8, 11],
  [12, 15], [16, 255], [14, 255], [17, 255], [13, 255],
];
const SLOT_IS_CARRIER = [
  0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 1,
];
const MELODIC_VOICE_OF_SLOT = [
  0, 1, 2, 0, 1, 2, 3, 4, 5, 3, 4, 5, 6, 7, 8, 6, 7, 8,
];
const PERCUSSIVE_VOICE_OF_SLOT = [
  0, 1, 2, 0, 1, 2, 3, 4, 5, 3, 4, 5, BD, HH, TOM, BD, SD, TC,
];

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

export class AdlibDriver {
  /** @param {{write(reg:number, value:number):void}} chip */
  constructor(chip) {
    this.chip = chip;
    this.slotParams = Array.from({ length: 18 }, () => new Int32Array(14));
    this.reset();
  }

  /** §2. Leaves the chip in melodic mode with every voice at full volume. */
  reset() {
    for (let r = 1; r <= 0xf5; r++) this.chip.write(r, 0);
    this.chip.write(0x04, 0x06);

    this.voiceNote = new Int32Array(9);
    this.voiceKeyOn = new Int32Array(9);
    this.voiceBend = new Int32Array(9).fill(MID_PITCH);
    this.bxCache = new Int32Array(9);
    this.voiceVolume = new Int32Array(11).fill(MAX_VOLUME);
    this.percBits = 0;
    this.percussion = false;
    this.voiceCount = 9;
    this.amDepth = 0;
    this.vibDepth = 0;
    this.noteSelect = 0;
    this.pitchRange = 1;
    this.waveSelect = true;
    for (const p of this.slotParams) p.fill(0);

    this.setMode(false);
    this.setGlobalParams(0, 0, 0);
    this.setPitchRange(1);
    this.setWaveSelect(true);
  }

  /** §6. `percussive` true puts the chip in rhythm mode. */
  setMode(percussive) {
    if (percussive) {
      this.voiceNote[TOM] = TOM_PITCH;
      this.voiceBend[TOM] = MID_PITCH;
      this.percussion = true;              // slot maps must already be percussive
      this.#updateFNums(TOM);
      this.voiceNote[SD] = TOM_PITCH + TOM_TO_SD;
      this.voiceBend[SD] = MID_PITCH;
      this.#updateFNums(SD);
    }
    this.percussion = percussive;
    this.voiceCount = percussive ? 11 : 9;
    this.percBits = 0;
    this.#sendAmVibRhythm();
  }

  setWaveSelect(on) {
    this.waveSelect = !!on;
    for (let s = 0; s < 18; s++) this.chip.write(0xe0 + SLOT_OFFSET[s], 0);
    this.chip.write(0x01, on ? 0x20 : 0);
  }

  /** §5.2. Clamped into 1…12 semitones, as the driver does. */
  setPitchRange(semitones) {
    this.pitchRange = Math.min(12, Math.max(1, semitones | 0));
  }

  setGlobalParams(amDepth, vibDepth, noteSelect) {
    this.amDepth = amDepth; this.vibDepth = vibDepth; this.noteSelect = noteSelect;
    this.#sendAmVibRhythm();
    this.chip.write(0x08, noteSelect ? 0x40 : 0);
  }

  /** §3. Load a parsed bank patch into a voice. */
  setVoiceTimbre(voice, patch) {
    if (voice >= this.voiceCount) return;
    const slots = this.#slotsOf(voice);
    this.#setSlot(slots[0], operatorParams(patch.modulator), patch.modWave);
    if (slots[1] !== 255) {
      this.#setSlot(slots[1], operatorParams(patch.carrier), patch.carWave);
    }
  }

  /** §4. Channel volume, 0…127. */
  setVoiceVolume(voice, volume) {
    if (voice >= this.voiceCount) return;
    this.voiceVolume[voice] = Math.min(MAX_VOLUME, volume | 0);
    const slots = this.#slotsOf(voice);
    this.#sendKslLevel(slots[0]);
    if (slots[1] !== 255) this.#sendKslLevel(slots[1]);
  }

  /** §5. 14-bit bend, 0x2000 is centre. Melodic voices and the bass drum. */
  setVoicePitch(voice, bend) {
    if ((!this.percussion && voice < 9) || voice <= BD) {
      this.voiceBend[voice] = Math.min(0x3fff, Math.max(0, bend | 0));
      this.#updateFNums(voice);
    }
  }

  /** §7. `note` is a MIDI note number. */
  noteOn(voice, note) {
    let pitch = note - MIDI_TO_CHIP;
    if (pitch < 0) pitch = 0;
    if ((!this.percussion && voice < 9) || voice < BD) {
      this.voiceNote[voice] = pitch;
      this.voiceKeyOn[voice] = 0x20;
      this.#updateFNums(voice);
    } else if (this.percussion && voice <= HH) {
      if (voice === BD) {
        this.voiceNote[BD] = pitch;
        this.#updateFNums(BD);
      } else if (voice === TOM && this.voiceNote[TOM] !== pitch) {
        // §6: only the tom carries a pitch, and it drags the snare with it.
        this.voiceNote[TOM] = pitch;
        this.voiceNote[SD] = pitch + TOM_TO_SD;
        this.#updateFNums(TOM);
        this.#updateFNums(SD);
      }
      this.percBits |= RHYTHM_MASK[voice - BD];
      this.#sendAmVibRhythm();
    }
  }

  /** §7. */
  noteOff(voice) {
    if ((!this.percussion && voice < 9) || voice < BD) {
      this.voiceKeyOn[voice] = 0;
      this.bxCache[voice] &= ~0x20;
      this.chip.write(0xb0 + voice, this.bxCache[voice]);
    } else if (this.percussion && voice <= HH) {
      this.percBits &= ~RHYTHM_MASK[voice - BD];
      this.#sendAmVibRhythm();
    }
  }

  #slotsOf(voice) {
    return this.percussion ? PERCUSSIVE_SLOTS[voice] : MELODIC_SLOTS[voice];
  }

  #voiceOfSlot(slot) {
    return this.percussion ? PERCUSSIVE_VOICE_OF_SLOT[slot] : MELODIC_VOICE_OF_SLOT[slot];
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

  /** §4. The three-way condition is the whole point of this routine. */
  #sendKslLevel(slot) {
    const p = this.slotParams[slot];
    const voice = this.#voiceOfSlot(slot);
    let amplitude = 63 - (p[P_LEVEL] & 63);
    const singleSlot = this.percussion && voice > BD;
    if (SLOT_IS_CARRIER[slot] || !p[P_CONNECTION] || singleSlot) {
      amplitude = (amplitude * this.voiceVolume[voice] + (MAX_VOLUME + 1) / 2) >> 7;
    }
    const value = (63 - amplitude) | ((p[P_KSL] & 3) << 6);
    this.chip.write(0x40 + SLOT_OFFSET[slot], value);
  }

  #sendFeedbackConnection(slot) {
    if (SLOT_IS_CARRIER[slot]) return;
    const p = this.slotParams[slot];
    const value = ((p[P_FEEDBACK] & 7) << 1) | (p[P_CONNECTION] ? 0 : 1);
    this.chip.write(0xc0 + MELODIC_VOICE_OF_SLOT[slot], value);
  }

  #sendAttackDecay(slot) {
    const p = this.slotParams[slot];
    this.chip.write(0x60 + SLOT_OFFSET[slot],
      ((p[P_ATTACK] & 0x0f) << 4) | (p[P_DECAY] & 0x0f));
  }

  #sendSustainRelease(slot) {
    const p = this.slotParams[slot];
    this.chip.write(0x80 + SLOT_OFFSET[slot],
      ((p[P_SUSTAIN] & 0x0f) << 4) | (p[P_RELEASE] & 0x0f));
  }

  #sendAmVibEgKsrMultiple(slot) {
    const p = this.slotParams[slot];
    const value = (p[P_AM] ? 0x80 : 0) | (p[P_VIB] ? 0x40 : 0) |
      (p[P_EG] ? 0x20 : 0) | (p[P_KSR] ? 0x10 : 0) | (p[P_MULTIPLE] & 0x0f);
    this.chip.write(0x20 + SLOT_OFFSET[slot], value);
  }

  #sendWaveSelect(slot) {
    const wave = this.waveSelect ? this.slotParams[slot][13] & 3 : 0;
    this.chip.write(0xe0 + SLOT_OFFSET[slot], wave);
  }

  #sendAmVibRhythm() {
    const value = (this.amDepth ? 0x80 : 0) | (this.vibDepth ? 0x40 : 0) |
      (this.percussion ? 0x20 : 0) | this.percBits;
    this.chip.write(0xbd, value);
  }

  /** §5.2. */
  #updateFNums(voice) {
    this.bxCache[voice] = this.#setFreq(
      voice, this.voiceNote[voice], this.voiceBend[voice], this.voiceKeyOn[voice]);
  }

  #setFreq(voice, note, bend, keyOn) {
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

    this.chip.write(0xa0 + voice, fnum & 0xff);
    const bx = keyOn | ((block & 7) << 2) | ((fnum >> 8) & 3);
    this.chip.write(0xb0 + voice, bx);
    return bx;
  }
}
