// The public entry point: files in, audio out.
//
// Everything below the resampler is rate-agnostic and runs anywhere Node or a
// browser does. The Web Audio wiring lives in the frontend, not here.

import { OPL2 } from "./opl/chip.js";
import { NATIVE_RATE, METER_VOICES, METER_STRIDE, M_VOLUME } from "./opl/constants.js";
import {
  parseIms, parseRol, parseBnk, parseIss, resolvePatches, identify, deltaGcd,
  resolveIssSpans,
} from "./formats.js";
import { Sequencer, imsSequence, rolSequence } from "./sequencer.js";

export { OPL2, NATIVE_RATE, parseIms, parseRol, parseBnk, parseIss, identify, deltaGcd };
export {
  METER_VOICES, METER_STRIDE, METER_BD, METER_SD, METER_TOM, METER_TC, METER_HH,
  M_PEAK, M_MOD_DB, M_NOTE, M_KEY_ON, M_STATE, M_VOLUME, M_TIMBRE,
  T_CAR_WAVE, T_MOD_WAVE, T_ADDITIVE, T_FEEDBACK,
  CF_RHYTHM, CF_TREMOLO, CF_VIBRATO, CF_WAVESEL,
  EG_OFF, EG_ATTACK, EG_DECAY, EG_SUSTAIN, EG_RELEASE,
} from "./opl/constants.js";
export { resolveIssSpans } from "./formats.js";
export { decodeJohab, decodeJohabField } from "./johab2unicode.js";

/**
 * A loaded song, ready to render.
 *
 * The chip runs at its own 49716 Hz whatever the caller asks for; `render()`
 * resamples on the way out, because resampling a mono chiptune is cheaper and
 * less surprising than pretending the chip has another clock.
 */
export class IyagiMusic {
  /**
   * @param {object} opts
   * @param {Uint8Array} opts.song           .ims or .rol bytes
   * @param {Uint8Array} [opts.bank]         .bnk bytes, song-specific
   * @param {Uint8Array} [opts.fallbackBank] .bnk bytes, the general bank
   * @param {Uint8Array} [opts.lyrics]       .iss bytes
   * @param {number} [opts.sampleRate]       output rate; default 48000
   * @param {(code:number)=>string|null} [opts.userGlyph]
   *   what to show for Iyagi's own font glyphs (JOHAB_ENCODING §5). They are
   *   decorative separators and brackets, so a middle dot reads better than a
   *   row of replacement characters; pass null to see them as U+FFFD instead.
   */
  constructor(opts) {
    const kind = identify(opts.song);
    if (kind !== "ims" && kind !== "rol") {
      throw new Error("not a playable song file");
    }
    this.kind = kind;
    this.sampleRate = opts.sampleRate ?? 48000;
    const glyph = opts.userGlyph === undefined ? () => "\u00b7" : opts.userGlyph;
    this.textOptions = glyph ? { userGlyph: glyph } : undefined;
    this.bank = opts.bank ? parseBnk(opts.bank) : null;
    this.fallbackBank = opts.fallbackBank ? parseBnk(opts.fallbackBank) : null;
    this.lyrics = opts.lyrics ? parseIss(opts.lyrics, this.textOptions) : null;
    this.chip = new OPL2();

    if (kind === "ims") {
      this.song = parseIms(opts.song, this.textOptions);
      this.patches = resolvePatches(this.song, this.bank, this.fallbackBank);
      this.missing = this.song.patchNames.filter((_, i) => !this.patches[i]);
      this.sequencer = new Sequencer({
        chip: this.chip,
        events: { [Symbol.iterator]: () => imsSequence(this.song)[Symbol.iterator]() },
        tickBeat: this.song.tickBeat,
        tempo: this.song.tempo,
        percussive: this.song.percussive,
        pitchRange: this.song.pitchRange,
        patches: this.patches,
      });
    } else {
      this.song = parseRol(opts.song, this.textOptions);
      const resolve = (name) => {
        const key = name.toUpperCase();
        return this.bank?.byName.get(key) ?? this.fallbackBank?.byName.get(key) ?? null;
      };
      const names = new Set(
        this.song.voices.flatMap((v) => v.timbres.map((t) => t.name)).filter(Boolean));
      this.missing = [...names].filter((n) => !resolve(n));
      const events = rolSequence(this.song, resolve);
      this.sequencer = new Sequencer({
        chip: this.chip,
        events,
        tickBeat: this.song.tickBeat,
        tempo: this.song.tempoTrack.tempo,
        percussive: this.song.percussive,
        pitchRange: 1,
        patches: [],
      });
    }

    // Nine channels summing into one mono bus can reach about 1.4 when a song
    // uses every voice at full level, and the chip's own DAC would clip there
    // too. Back off instead, and clamp what still overshoots.
    this.gain = opts.gain ?? 0.7;
    this.ratio = NATIVE_RATE / this.sampleRate;
    this.nativeBuf = new Float32Array(2048);
    this.nativeLen = 0;
    this.nativePos = 0;
    this.prevSample = 0;
    this.frac = 0;
  }

  /** Song title, already decoded from Johab. */
  get title() {
    return this.kind === "ims" ? this.song.title : this.song.title;
  }

  /** Whether the song has run past its end marker. */
  get ended() { return this.sequencer.ended && this.nativePos >= this.nativeLen; }

  get loop() { return this.sequencer.loop; }
  set loop(v) { this.sequencer.loop = !!v; }

  /** Seconds of song rendered so far. */
  get seconds() { return this.sequencer.samplesRendered / NATIVE_RATE; }

  /** Current tick, for lining lyrics up. */
  get tick() { return this.sequencer.tick; }

  // ── what the player looks like from outside ─────────────────────────────

  /** How many voices this song has: 9 melodic, or 6 melodic and 5 drums. */
  get voiceCount() { return this.sequencer.driver.voiceCount; }

  /** Chip-wide switches, as the CF_* bits. */
  get chipFlags() { return this.chip.chipFlags; }

  /** Bank patch names by voice, and a counter that moves when one changes. */
  get patchNames() { return this.sequencer.voicePatchName; }
  get patchEpoch() { return this.sequencer.patchEpoch; }

  /** A buffer the right size for `readMeters`. */
  static meterBuffer() { return new Float32Array(METER_VOICES * METER_STRIDE); }

  /**
   * Per-voice meter rows for a display; see `OPL2.readMeters`, which does most
   * of it. Reading clears the peak accumulators, so call it once per frame.
   */
  readMeters(out) {
    this.chip.readMeters(out);
    const volume = this.sequencer.driver.voiceVolume;
    for (let v = 0; v < METER_VOICES; v++) out[v * METER_STRIDE + M_VOLUME] = volume[v];
    return out;
  }

  reset() {
    this.chip.reset();
    this.sequencer.reset();
    this.nativeLen = this.nativePos = 0;
    this.frac = 0;
    this.prevSample = 0;
  }

  #nextNative() {
    if (this.nativePos >= this.nativeLen) {
      if (this.sequencer.ended) return 0;
      this.nativeLen = this.sequencer.render(this.nativeBuf, 0, this.nativeBuf.length);
      this.nativePos = 0;
      if (this.nativeLen === 0) return 0;
    }
    return this.nativeBuf[this.nativePos++];
  }

  /**
   * Fill `out` with mono samples at the requested rate. Returns false once the
   * song has finished and the buffer has been zero-filled.
   */
  render(out, offset = 0, count = out.length - offset) {
    if (this.ended) { out.fill(0, offset, offset + count); return false; }
    for (let i = 0; i < count; i++) {
      // Linear interpolation between chip samples: the chip's 49716 Hz is not
      // a neat ratio of any audio device's rate.
      while (this.frac >= 1) { this.prevSample = this.#nextNative(); this.frac -= 1; }
      const next = this.nativePos < this.nativeLen
        ? this.nativeBuf[this.nativePos]
        : this.prevSample;
      const v = (this.prevSample + (next - this.prevSample) * this.frac) * this.gain;
      out[offset + i] = Math.fround(v > 1 ? 1 : v < -1 ? -1 : v);
      this.frac += this.ratio;
    }
    return true;
  }

  /** Fill interleaved stereo by duplicating the mono chip output. */
  renderStereo(left, right, offset = 0, count = left.length - offset) {
    const ok = this.render(left, offset, count);
    right.set(left.subarray(offset, offset + count), offset);
    return ok;
  }

  /** Render the whole song to one array, capped at `maxSeconds`. */
  renderAll(maxSeconds = 600) {
    const cap = Math.ceil(maxSeconds * this.sampleRate);
    const chunks = [];
    const block = new Float32Array(4096);
    let total = 0;
    while (total < cap) {
      if (!this.render(block, 0, block.length)) break;
      chunks.push(block.slice());
      total += block.length;
    }
    const out = new Float32Array(Math.min(total, cap));
    let o = 0;
    for (const c of chunks) {
      const n = Math.min(c.length, out.length - o);
      out.set(c.subarray(0, n), o);
      o += n;
      if (o >= out.length) break;
    }
    return out;
  }

  /**
   * The lyric span that should be coloured at the current tick, if any:
   * `{line, text, from, to}` with `from`/`to` in character cells. See
   * `resolveIssSpans` -- a cue marks the right edge of the highlight, not an
   * isolated run.
   */
  lyricAt(tick = this.tick) {
    if (!this.lyrics) return null;
    this.lyricSpans ??= resolveIssSpans(this.lyrics);
    let index = -1;
    for (let i = 0; i < this.lyrics.cues.length; i++) {
      if (this.lyrics.cues[i].tick > tick) break;
      index = i;
    }
    if (index < 0) return null;
    const span = this.lyricSpans[index];
    return { ...span, text: this.lyrics.lines[span.line] ?? "" };
  }
}
