// Sample voices, mixed beside the chip.
//
// Nothing here is an OPL. A format that carries digital audio -- a
// version-0.2 SOP's WAV tracks (SOP §10), and whatever else turns up -- has
// its samples played by these voices and added into the chip's own output,
// at the chip's own rate, so they sit on the same clock as the FM and are
// resampled with it on the way out. Like `opl/chip.js` this is pure
// computation: no DOM, no Web Audio, no `console`.
//
// It knows nothing about notes, volumes or pan positions. The caller says what
// rate a sample plays at and how loud it is on each side, as plain numbers,
// because how a note, a volume or a pan becomes those is the format's -- for
// SOP 0.2, the rules of the game that played it (SOP §10.6).

import { NATIVE_RATE } from "./opl/constants.js";

/**
 * A full-scale sample is as loud on the bus as one full-amplitude operator,
 * which the chip scales to about 0.5 (MIX_SCALE in `opl/chip.js`). So a
 * sample voice is one more voice, and the player's headroom -- measured for
 * the chip's voices -- is not thrown by it.
 */
const PCM_SCALE = 0.5;

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
    /** Linear gains, 0..1, on each side of a stereo bus; `left` alone on a mono one. */
    this.left = 1;
    this.right = 1;
    this.gain = 1;
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

  /** @param {number} voice @param {number} gain linear, 1 for as recorded */
  setGain(voice, gain) { this.voices[voice].gain = gain; }

  /**
   * How much of the voice each side of a stereo bus gets, linear 0..1. A mono
   * bus takes the voice at its gain whatever these say, as a mono chip has no
   * pan to honour.
   * @param {number} voice @param {number} left @param {number} right
   */
  setPan(voice, left, right) {
    const v = this.voices[voice];
    v.left = left;
    v.right = right;
  }

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
   * voice exactly.
   *
   * @param {Float32Array} left @param {Float32Array|null} right
   * @param {number} offset @param {number} count
   */
  mix(left, right, offset, count) {
    for (const v of this.voices) {
      const s = v.playing;
      if (!s) continue;
      const g = (v.gain * PCM_SCALE) / 128;
      const gl = right ? v.left : 1;
      const gr = right ? v.right : 0;
      const last = s.length - 1;
      let pos = v.pos;
      let peak = v.peak;
      for (let n = 0; n < count; n++) {
        const i = Math.floor(pos);
        if (i >= last) { v.playing = null; break; }
        const f = pos - i;
        const x = (s[i] + (s[i + 1] - s[i]) * f) * g;
        left[offset + n] += x * gl;
        if (gr) right[offset + n] += x * gr;
        // Before panning, as the chip's meters read a channel's output.
        const a = x < 0 ? -x : x;
        if (a > peak) peak = a;
        pos += v.step;
      }
      v.pos = pos;
      v.peak = peak;
    }
  }
}
