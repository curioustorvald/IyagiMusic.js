// Sample voices, mixed beside the chip.
//
// Nothing here is an OPL. A format that carries digital audio -- a
// version-0.2 SOP's WAV tracks (SOP §10), and whatever else turns up -- has
// its samples played by these voices and added into the chip's own output,
// at the chip's own rate, so they sit on the same clock as the FM and are
// resampled with it on the way out. Like `opl/chip.js` this is pure
// computation: no DOM, no Web Audio, no `console`.
//
// It knows nothing about notes. The caller says what rate a sample plays at,
// because how a note becomes a rate is a property of the format -- and for
// SOP 0.2, not yet a known one (SOP §10.6).

import { NATIVE_RATE, PAN_LEFT, PAN_RIGHT, PAN_CENTRE } from "./opl/constants.js";

/**
 * A full-scale sample is as loud on the bus as one full-amplitude operator,
 * which the chip scales to about 0.5 (MIX_SCALE in `opl/chip.js`). So a
 * sample voice is one more voice, and the player's headroom -- measured for
 * the chip's voices -- is not thrown by it.
 */
const PCM_SCALE = 0.5;

/**
 * Volume 0..127 as a gain, by the law the driver uses on a carrier at full
 * level: `63 − ((63 × volume + 64) >> 7)` steps of 0.75 dB (SOP §8). A sample
 * at volume 96 is then 12 dB down, exactly as an FM voice beside it is, which
 * matters more than any absolute choice would: the only thing a listener can
 * judge is the balance.
 * @param {number} volume
 */
export function pcmVolumeGain(volume) {
  const v = Math.max(0, Math.min(127, volume | 0));
  const steps = 63 - ((63 * v + 64) >> 7);
  return v === 0 ? 0 : 10 ** (-0.75 * steps / 20);
}

/**
 * A sample, as the mixer takes it: signed 8-bit mono at `rate`. The shape a
 * SOP's `SopPcm` already has.
 * @typedef {object} PcmSample
 * @property {Int8Array} samples
 * @property {number} rate Hz, at which the samples play as recorded
 */

class PcmVoice {
  constructor() { this.reset(); }

  reset() {
    /** @type {PcmSample|null} what the voice will play at its next trigger */
    this.sample = null;
    /** @type {Int8Array|null} what it is playing now; null when silent */
    this.playing = null;
    this.pos = 0;
    this.step = 0;
    this.volume = 96;
    this.gain = pcmVolumeGain(96);
    this.pan = PAN_CENTRE;
    /** Loudest |output| since the last `takePeak`, on the chip's bus scale. */
    this.peak = 0;
  }
}

export class PcmMixer {
  /**
   * @param {number} voices how many sample voices
   * @param {number} [rate] the rate `mix` is called at; the chip's, by default
   */
  constructor(voices, rate = NATIVE_RATE) {
    this.rate = rate;
    this.voices = Array.from({ length: voices }, () => new PcmVoice());
  }

  get voiceCount() { return this.voices.length; }

  reset() { for (const v of this.voices) v.reset(); }

  /** @param {number} voice @param {PcmSample|null} sample */
  setSample(voice, sample) { this.voices[voice].sample = sample; }

  /** @param {number} voice @param {number} volume 0..127 */
  setVolume(voice, volume) {
    const v = this.voices[voice];
    v.volume = volume;
    v.gain = pcmVolumeGain(volume);
  }

  /** @param {number} voice @param {number} pan one of the PAN_* values */
  setPan(voice, pan) { this.voices[voice].pan = pan; }

  /**
   * Start the voice's sample from the top, at `rate` Hz. A voice already
   * playing is cut and restarted, as a tracker's is.
   * @param {number} voice @param {number} rate
   */
  trigger(voice, rate) {
    const v = this.voices[voice];
    if (!v.sample || !(rate > 0)) { v.playing = null; return; }
    v.playing = v.sample.samples;
    v.pos = 0;
    v.step = rate / this.rate;
  }

  /** Change the rate of what is playing, without restarting it. */
  retune(voice, rate) {
    const v = this.voices[voice];
    if (v.playing && rate > 0) v.step = rate / this.rate;
  }

  /** @param {number} voice */
  stop(voice) { this.voices[voice].playing = null; }

  /** Whether any voice is sounding. */
  get active() { return this.voices.some((v) => v.playing); }

  /**
   * The loudest this voice has been since the last call, on the same scale
   * as the chip's meter peaks, and start counting again. For a display, as
   * the chip's own `readMeters` is.
   * @param {number} voice
   */
  takePeak(voice) {
    const v = this.voices[voice];
    const p = v.peak;
    v.peak = 0;
    return p;
  }

  /**
   * Add `count` samples of every sounding voice into `left` (and `right`, on
   * a stereo bus) at `offset`. Linear interpolation: these are 8-bit sounds
   * at 8 to 22 kHz, and anything finer would be polishing their noise.
   *
   * On a stereo bus a centred voice goes into both sides at full level, as
   * the OPL3's own centred channels do, so a mono fold of the two is the
   * voice exactly; PAN_NONE, both switches off, is silence there as on the
   * chip.
   *
   * @param {Float32Array} left @param {Float32Array|null} right
   * @param {number} offset @param {number} count
   */
  mix(left, right, offset, count) {
    for (const v of this.voices) {
      const s = v.playing;
      if (!s) continue;
      const g = (v.gain * PCM_SCALE) / 128;
      // A mono bus has no pan to honour, as a mono chip has none.
      const toL = right ? (v.pan === PAN_LEFT || v.pan === PAN_CENTRE) : true;
      const toR = !!right && (v.pan === PAN_RIGHT || v.pan === PAN_CENTRE);
      const last = s.length - 1;
      let pos = v.pos;
      let peak = v.peak;
      for (let n = 0; n < count; n++) {
        const i = Math.floor(pos);
        if (i >= last) { v.playing = null; break; }
        const f = pos - i;
        const x = (s[i] + (s[i + 1] - s[i]) * f) * g;
        if (toL) left[offset + n] += x;
        if (toR) right[offset + n] += x;
        // Heard or not: a voice panned to nothing still moves its meter, as a
        // chip channel with both switches off does.
        const a = x < 0 ? -x : x;
        if (a > peak) peak = a;
        pos += v.step;
      }
      v.pos = pos;
      v.peak = peak;
    }
  }
}
