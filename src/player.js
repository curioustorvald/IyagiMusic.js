// The public entry point: files in, audio out.
//
// Everything below the resampler is rate-agnostic and runs anywhere Node or a
// browser does. The Web Audio wiring lives in the frontend, not here.

import { OPL2, OPL3 } from "./opl/chip.js";
import {
  NATIVE_RATE, METER_VOICES, METER_STRIDE, M_VOLUME, M_PEAK, CHANNEL_COUNT, RHYTHM_VOICES,
  M_MOD_DB, M_NOTE, M_KEY_ON, M_STATE, M_TIMBRE, M_PAN, EG_OFF, EG_SUSTAIN,
} from "./opl/constants.js";
import { voiceLayout, IMPLAY_PAN } from "./driver.js";
import {
  parseIms, parseRol, parseBnk, parseIss, parseSop, resolvePatches,
  identify, deltaGcd, resolveIssSpans, ISS_TICK_BEAT,
} from "./formats.js";
import {
  Sequencer, imsSequence, rolSequence, sopSequence, sopTempo, sopSampleTracks,
  SOP_SAMPLE_REFERENCE, SOP_SAMPLE_CUT,
} from "./sequencer.js";

export { OPL2, OPL3, NATIVE_RATE, parseIms, parseRol, parseBnk, parseIss, identify, deltaGcd };
export { parseSop, sopPatch } from "./formats.js";
export {
  METER_VOICES, METER_STRIDE, METER_BD, METER_SD, METER_TOM, METER_TC, METER_HH,
  RHYTHM_VOICES, R_BD, R_SD, R_TOM, R_TC, R_HH,
  M_PEAK, M_MOD_DB, M_NOTE, M_KEY_ON, M_STATE, M_VOLUME, M_TIMBRE, M_PAN,
  T_CAR_WAVE, T_MOD_WAVE, T_ADDITIVE, T_FEEDBACK, T_FOUROP, T_CONN2,
  T_WAVE_MASK, T_FEEDBACK_MASK,
  PAN_NONE, PAN_LEFT, PAN_RIGHT, PAN_CENTRE,
  CF_RHYTHM, CF_TREMOLO, CF_VIBRATO, CF_WAVESEL, CF_OPL3, CF_FOUROP,
  EG_OFF, EG_ATTACK, EG_DECAY, EG_SUSTAIN, EG_RELEASE,
} from "./opl/constants.js";
export { resolveIssSpans, ISS_TICK_BEAT } from "./formats.js";
export { decodeJohab, decodeJohabField } from "./johab2unicode.js";

/** @typedef {import("./formats.js").Patch} Patch */

/** Output scale by chip, before the caller overrides it. See `headroom` below. */
const DEFAULT_GAIN = { opl2: 0.55, opl3: 0.32 };

export { IMPLAY_PAN };

/**
 * The "standard" tone: what a sound card designed today would do with the
 * same chip. Feedback backed off by an eighth, and one pole of low-pass at
 * 12 kHz on the chip's own output, which takes off the aliasing a 49.7 kHz
 * DAC with no reconstruction filter to speak of leaves at the top. "raw" is
 * the chip verbatim, and the library's default.
 */
const STANDARD_FEEDBACK = 0.875;
const STANDARD_CUTOFF_HZ = 12000;
/**
 * The low-pass is one pole by the bilinear transform, prewarped: −3 dB at the
 * cutoff exactly, and a zero at the chip's Nyquist. The simpler y += a·(x − y)
 * places its pole by the impulse response instead, and with a cutoff this
 * close to Nyquist that leaves it −2.3 dB at 12 kHz and never more than −4 dB
 * anywhere -- a filter in name only.
 *
 *   y[n] = B·(x[n] + x[n−1]) + A·y[n−1]
 */
const STANDARD_WARP = Math.tan(Math.PI * STANDARD_CUTOFF_HZ / NATIVE_RATE);
const STANDARD_B = STANDARD_WARP / (1 + STANDARD_WARP);
const STANDARD_A = (1 - STANDARD_WARP) / (1 + STANDARD_WARP);

/**
 * The lyric text that should be lit at a given tick, and how much of it.
 * `from` and `to` are character cells into `text`, not string indices.
 * @typedef {object} LyricSpan
 * @property {number} line index into the ISS's lines
 * @property {string} text the whole line
 * @property {number} from @property {number} to
 */

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
   * @param {Uint8Array} opts.song           .ims, .rol or .sop bytes
   * @param {Uint8Array} [opts.bank]         .bnk bytes, song-specific; a .sop needs none
   * @param {Uint8Array} [opts.fallbackBank] .bnk bytes, the general bank
   * @param {Uint8Array} [opts.lyrics]       .iss bytes
   * @param {number} [opts.sampleRate]       output rate; default 48000
   * @param {"auto"|"opl2"|"opl3"} [opts.chip]
   *   which chip to play the song on. "auto" -- the default -- gives a `.sop`
   *   the YMF262 it was written for and everything else the YM3812 it was
   *   written for. "opl2" forces the nine-voice reduction a `.sop` used to get
   *   (SOP §8), which is worth having for comparison and for nothing else.
   * @param {boolean} [opts.implayStereo]
   *   play an `.ims` or `.rol` in IMPLAY's stereo (ENGINE_SPEC §11.1): on a
   *   YMF262, every melodic voice on both register banks with a fixed pan per
   *   channel. `mono` then switches between that and a mono mix identical to
   *   the YM3812's without reloading. Ignored for a `.sop`, and when `chip`
   *   is given as anything but "auto".
   * @param {"raw"|"standard"} [opts.tone]   see `tone`; default "raw"
   * @param {number|null} [opts.sampleReference] see `sampleReference`
   * @param {boolean} [opts.sampleCut]       see `sampleCut`
   * @param {number} [opts.gain]             output scale; default by chip, see below
   * @param {(code:number)=>string|null} [opts.userGlyph]
   *   overrides the built-in mapping for Iyagi's own font glyphs
   *   (JOHAB_ENCODING §5). They decode to their Unicode equivalents now, so
   *   this is only for callers that would rather keep the codes
   *   distinguishable -- an editor round-tripping the bytes, say.
   */
  constructor(opts) {
    const kind = identify(opts.song);
    if (kind !== "ims" && kind !== "rol" && kind !== "sop") {
      throw new Error("not a playable song file");
    }
    this.kind = kind;
    this.sampleRate = opts.sampleRate ?? 48000;
    this.textOptions = opts.userGlyph ? { userGlyph: opts.userGlyph } : undefined;
    this.bank = opts.bank ? parseBnk(opts.bank) : null;
    this.fallbackBank = opts.fallbackBank ? parseBnk(opts.fallbackBank) : null;
    this.lyrics = opts.lyrics ? parseIss(opts.lyrics, this.textOptions) : null;
    // A `.sop` is an OPL3 format (SOP §1) and an `.ims` or `.rol` is an AdLib
    // one; nothing has to be guessed here, only honoured.
    const want = opts.chip ?? "auto";
    if (want !== "auto" && want !== "opl2" && want !== "opl3") {
      throw new Error(`unknown chip ${JSON.stringify(want)}: use "auto", "opl2" or "opl3"`);
    }
    /**
     * §11.1: IMPLAY's stereo. The chip is a YMF262, but the voices are still
     * the YM3812's nine, each played twice.
     * @type {boolean}
     */
    this.mirror = !!opts.implayStereo && want === "auto" && kind !== "sop";
    /** @type {"opl2"|"opl3"} */
    this.chipKind = this.mirror ? "opl3"
      : want === "auto" ? (kind === "sop" ? "opl3" : "opl2") : want;
    this.chip = this.chipKind === "opl3" ? new OPL3() : new OPL2();
    const mirror = this.mirror;

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
        mirror,
      });
      /** How many instruments the song names -- IMPLAY's "사용 악기". */
      this.instrumentCount = this.song.patchNames.length;
    } else if (kind === "sop") {
      // A SOP carries its own instruments, so there is no bank to resolve and
      // nothing that can go missing. How its twenty tracks are laid over the
      // chip's voices is `sopSequence`'s business, and SOP §8 spells it out.
      this.song = parseSop(opts.song, this.textOptions);
      this.missing = [];
      this.sequencer = new Sequencer({
        chip: this.chip,
        events: sopSequence(this.song,
          voiceLayout(this.chipKind === "opl3", this.song.percussive)),
        tickBeat: this.song.tickBeat,
        // SOP §1, §5: Note starts every song at 120 and never reads
        // basicTempo; the timer makes that 120.04.
        tempo: sopTempo(120, this.song.tickBeat),
        percussive: this.song.percussive,
        sop: true,                            // SOP §8.1: play it as NOTE.EXE does
        patches: [],
        // SOP §10.2: a version-0.2 WAV track is a sample voice of its own.
        sampleVoices: sopSampleTracks(this.song).length,
      });
      // §10.6: note 24 plays a sample as recorded, and the note's length is
      // how long it plays.
      this.sequencer.sampleReference = SOP_SAMPLE_REFERENCE;
      this.sequencer.sampleCut = SOP_SAMPLE_CUT;
      this.instrumentCount = this.song.instruments.filter(Boolean).length;
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
        mirror,
      });
      this.instrumentCount = names.size;
    }

    /**
     * Nine channels summing into one bus can reach about 1.4 when a song uses
     * every voice at full level, and the chip's own DAC would clip there too.
     * Back off instead, and clamp what still overshoots.
     *
     * An OPL3 song reaches further, because it has more than twice the voices
     * and each one is exactly as loud (see MIX_SCALE in `opl/chip.js`). Voices
     * not playing the same note sum in power rather than in amplitude, so the
     * derivation says √(9/20) = 0.67 of the OPL2's figure -- and the corpus
     * says 0.58. The derivation is a good first guess about uncorrelated
     * voices; real songs put their loudest voices on the same beat.
     *
     * **Both numbers are measured, and both were re-measured when the bus got
     * louder.** Summing the rhythm channels twice, as the chip does, put 6 dB
     * more into every rhythm-mode song, which is most of them; the figures
     * before that were 0.7 and 0.42. The protocol is the same either way: two
     * seconds of every corpus song, counting the samples the clamp has to
     * catch, and the standard is that no file loses more than 0.1% of them.
     *
     * | gain | over 0.1% | worst file |
     * |---|---|---|
     * | 1366 `.ims` at 0.70 | 7 files | `HOOT!!!.IMS`, 0.840% |
     * | …at 0.60 | 1 file | 0.237% |
     * | **…at 0.55** | **none** | **0.098%** |
     * | 336 `.sop` at 0.42 | 1 file | `MEGATON2.SOP`, 1.938% |
     * | …at 0.36 | 1 file | 0.187% |
     * | **…at 0.32** | **none** | **0.022%** |
     *
     * @type {number}
     */
    // IMPLAY's stereo puts each voice on each side at no more than its mono
    // level, so each bus is an OPL2's worth of voices and wants an OPL2's gain.
    this.headroom = opts.gain ?? DEFAULT_GAIN[this.mirror ? "opl2" : this.chipKind];
    /** @type {number} the scale actually applied; `volume` moves it. */
    this.gain = this.headroom;
    this.ratio = NATIVE_RATE / this.sampleRate;
    /** Whether the chip has two output buses. Set once the driver has run. */
    this.stereo = !!this.chip.stereo;
    this.nativeL = new Float32Array(2048);
    this.nativeR = this.stereo ? new Float32Array(2048) : this.nativeL;
    this.nativeLen = 0;
    this.nativePos = 0;
    this.prevL = 0;
    this.prevR = 0;
    this.frac = 0;
    /** @type {"raw"|"standard"} */
    this.toneMode = "raw";
    /** Low-pass state: last input and last output, per side. */
    this.filter = new Float64Array(4);
    this.tone = opts.tone ?? "raw";
    /** @type {boolean} */
    this.monoMix = false;
    if (opts.sampleReference !== undefined) this.sampleReference = opts.sampleReference;
    if (opts.sampleCut !== undefined) this.sampleCut = opts.sampleCut;
    /** Scratch rows for folding a mirrored chip's meters; see `readMeters`. */
    this.meterScratch = this.mirror ? new Float32Array(METER_VOICES * METER_STRIDE) : null;
  }

  // ── what a listener can change while it plays ───────────────────────────

  /**
   * "raw" is the chip as it is. "standard" backs its feedback off by an
   * eighth and puts one pole of low-pass at 12 kHz after it: see
   * STANDARD_FEEDBACK. Either can be switched mid-song.
   * @type {"raw"|"standard"}
   */
  get tone() { return this.toneMode; }
  set tone(v) {
    if (v !== "raw" && v !== "standard") {
      throw new Error(`unknown tone ${JSON.stringify(v)}: use "raw" or "standard"`);
    }
    this.toneMode = v;
    this.chip.feedbackScale = v === "standard" ? STANDARD_FEEDBACK : 1;
  }

  /**
   * Mono output. On a song in IMPLAY's stereo it centres every voice, which
   * is sample for sample what a YM3812 plays; on a `.sop` it folds the two
   * sides together. Takes effect at once. Nothing to do on a mono chip.
   * @type {boolean}
   */
  get mono() { return this.monoMix; }
  set mono(v) {
    this.monoMix = !!v;
    this.sequencer.driver.setMirrorPanning(!this.monoMix);
  }

  /** Whether `mono` would change anything: the song can come out in stereo. */
  get canStereo() { return this.stereo; }

  /**
   * Playback speed as a multiple of the song's tempo, 1 by default. IMPLAY
   * steps it in twentieths from 0 to 4 (ENGINE_SPEC §13); this takes any
   * positive number and leaves the stepping to the caller.
   * @type {number}
   */
  get speed() { return this.sequencer.speed; }
  set speed(v) { this.sequencer.setSpeed(v); }

  /**
   * Key shift in semitones for the melodic voices, 0 by default. It reaches
   * each voice at its next note, as IMPLAY's does. IMPLAY allows ±24.
   * @type {number}
   */
  get transpose() { return this.sequencer.transpose; }
  set transpose(v) { this.sequencer.transpose = Math.trunc(v) || 0; }

  /** How many sample voices the song has: four in a version-0.2 SOP, else none. */
  get sampleVoiceCount() { return this.sequencer.pcm?.voiceCount ?? 0; }

  /**
   * How a sample voice's note becomes a playback rate: the note at which a
   * sample plays at its own recorded rate, or null to play every note at that
   * rate. A version-0.2 SOP starts at 24 (SOP §10.6), which was found by ear
   * rather than read from anything, so it stays a setting. It reaches the
   * next sample struck.
   * @type {number|null}
   */
  get sampleReference() { return this.sequencer.sampleReference; }
  set sampleReference(v) {
    this.sequencer.sampleReference = v === null || v === undefined ? null : Math.trunc(v);
  }

  /**
   * Whether a sample stops when its note ends (true) or plays to its own end
   * (false). A version-0.2 SOP starts with true (SOP §10.6), a judgement
   * rather than a finding, so it stays a setting.
   * @type {boolean}
   */
  get sampleCut() { return this.sequencer.sampleCut; }
  set sampleCut(v) { this.sequencer.sampleCut = !!v; }

  /** The song's tempo right now, in bpm, before `speed`. */
  get tempo() { return this.sequencer.tempo; }

  /** Length of the song in seconds, at its own tempo. */
  get duration() { return this.sequencer.timeline().duration; }

  /** Where the song is, in seconds of song time: `duration` at the end. */
  get position() { return this.sequencer.songSamples / NATIVE_RATE; }

  /**
   * Jump to a point in the song, in seconds of song time. See
   * `Sequencer.seek` for what that does and why it sounds as it does.
   * @param {number} seconds
   */
  seek(seconds) {
    const timeline = this.sequencer.timeline();
    const tick = timeline.tickAt(Math.min(Math.max(0, seconds), timeline.duration));
    this.reset();
    this.sequencer.seek(tick);
  }

  /** Song title, already decoded from Johab. */
  get title() {
    return this.kind === "ims" ? this.song.title : this.song.title;
  }

  /**
   * Output volume as a fraction of the chip's headroom, 0…1 and 1 by default.
   *
   * A listener's volume control wants this rather than `gain`: how much of the
   * chip's range is safe to use depends on the chip, and a slider that means
   * "0.7" means something different on nine voices than on twenty.
   */
  get volume() { return this.gain / this.headroom; }
  set volume(v) { this.gain = this.headroom * (v > 0 ? v : 0); }

  /**
   * Whether the song has run past its end marker -- and past the end of any
   * sample still playing there, which is let ring out (`Sequencer.finished`).
   */
  get ended() { return this.sequencer.finished && this.nativePos >= this.nativeLen; }

  get loop() { return this.sequencer.loop; }
  set loop(v) { this.sequencer.loop = !!v; }

  /** Seconds of song rendered so far. */
  get seconds() { return this.sequencer.samplesRendered / NATIVE_RATE; }

  /** The sequencer's tick: the next event's, once the samples up to it are banked. */
  get tick() { return this.sequencer.tick; }

  /**
   * Where the song is in the unit an `.iss` cue is stamped in, which is what
   * to hold lyrics against: 240 to the beat, fractional (FILE_FORMATS §4.4).
   * For an `.ims` that is the song's own tick. A `.sop` counts `tickBeat` to
   * the beat, and a lyric beside it still counts 240, so it is scaled. A
   * `.rol` is left in its own ticks: no `.rol` in the corpus has lyrics, so
   * there is nothing to measure a rule against.
   * @type {number}
   */
  get lyricTick() {
    // The chip samples rendered but not yet resampled out are still to come.
    const buffered = (this.nativeLen - this.nativePos) / (this.sequencer.tickSeconds * NATIVE_RATE);
    const at = Math.max(0, this.sequencer.playhead - buffered);
    return this.kind === "sop" ? at * ISS_TICK_BEAT / this.song.tickBeat : at;
  }

  // ── what the player looks like from outside ─────────────────────────────

  /**
   * How many voices this song has: 9 melodic or 6 + 5 drums on a YM3812,
   * 18 melodic or 15 + 5 on a YMF262. It is also how many meter rows
   * `readMeters` fills, and the five drums are always the last five of them.
   */
  get voiceCount() { return this.sequencer.driver.voiceCount; }

  /** Chip-wide switches, as the CF_* bits. */
  get chipFlags() { return this.chip.chipFlags; }

  /**
   * Bank patch names by voice, sample names by sample voice, and a counter
   * that moves when either changes.
   */
  get patchNames() { return this.sequencer.voicePatchName; }
  get sampleNames() { return this.sequencer.sampleName ?? []; }
  get patchEpoch() { return this.sequencer.patchEpoch; }

  /** A buffer the right size for `readMeters`. */
  static meterBuffer() { return new Float32Array(METER_VOICES * METER_STRIDE); }

  /**
   * Per-voice meter rows for a display; see `OPL2.readMeters`, which does most
   * of it. Reading clears the peak accumulators, so call it once per frame.
   *
   * @param {Float32Array} out from `IyagiMusic.meterBuffer()`
   * @returns {Float32Array} the same buffer
   */
  readMeters(out) {
    if (this.mirror) this.#foldMeters(out);
    else this.chip.readMeters(out);
    const volume = this.sequencer.driver.voiceVolume;
    // Only the rows this chip has: past them the driver has no voice to read a
    // volume off, and writing `undefined` into a Float32Array writes NaN.
    for (let v = 0; v < this.chip.voiceRows; v++) out[v * METER_STRIDE + M_VOLUME] = volume[v];
    return out;
  }

  /** A buffer the right size for `readSampleMeters`: one row per sample voice. */
  sampleMeterBuffer() { return new Float32Array(Math.max(1, this.sampleVoiceCount) * METER_STRIDE); }

  /**
   * One meter row per sample voice, in the chip's row layout, so a display
   * can draw them with the code it draws voices with. They are kept out of
   * `readMeters` because the chip's rows promise the drums are their last
   * five, and sample voices come after the drums. Peak is on the chip's
   * scale; key-on is lit while the sample plays; the note is the note struck,
   * whatever rate that meant; the envelope state is sustain while it plays
   * and off otherwise, since a sample has no envelope. Reading clears the
   * peaks, as `readMeters` does.
   *
   * @param {Float32Array} out from `sampleMeterBuffer()`
   * @returns {Float32Array} the same buffer
   */
  readSampleMeters(out) {
    const pcm = this.sequencer.pcm;
    if (!pcm) return out;
    for (let v = 0; v < pcm.voiceCount; v++) {
      const o = v * METER_STRIDE;
      const voice = pcm.voices[v];
      const on = !!voice.playing;
      out[o + M_PEAK] = pcm.takePeak(v);
      out[o + M_MOD_DB] = -1;
      out[o + M_NOTE] = on ? this.sequencer.sampleNote[v] : -1;
      out[o + M_KEY_ON] = on ? 1 : 0;
      out[o + M_STATE] = on ? EG_SUSTAIN : EG_OFF;
      out[o + M_VOLUME] = voice.volume;
      out[o + M_TIMBRE] = 0;
      out[o + M_PAN] = voice.pan;
    }
    return out;
  }

  /**
   * IMPLAY's stereo shows up on the chip as eighteen channels -- every voice
   * twice -- and a display wants the nine the song has. Each voice's row is
   * its bank-0 channel's, with the louder of its two copies as the peak:
   * that is the side a listener hears it on. The drums are the chip's own
   * last five rows, as always.
   */
  #foldMeters(out) {
    const rows = this.chip.readMeters(this.meterScratch);
    out.fill(0);
    const melodic = this.sequencer.driver.melodicVoices;
    // The chip's rows: bank 0's melodic channels, then all nine of bank 1's.
    for (let v = 0; v < melodic; v++) {
      const o = v * METER_STRIDE;
      const twin = (melodic + v) * METER_STRIDE;
      out.set(rows.subarray(o, o + METER_STRIDE), o);
      out[o + M_PEAK] = Math.max(rows[o + M_PEAK], rows[twin + M_PEAK]);
    }
    if (this.sequencer.driver.percussion) {
      const from = (melodic + CHANNEL_COUNT) * METER_STRIDE;
      out.set(rows.subarray(from, from + RHYTHM_VOICES * METER_STRIDE), melodic * METER_STRIDE);
    }
    return out;
  }

  reset() {
    this.chip.reset();
    this.sequencer.reset();
    this.nativeLen = this.nativePos = 0;
    this.frac = 0;
    this.prevL = this.prevR = 0;
    this.filter.fill(0);
  }

  /** Take the next chip sample into `prevL`/`prevR`, refilling if need be. */
  #advance() {
    if (this.nativePos >= this.nativeLen) {
      if (this.sequencer.finished) { this.prevL = this.prevR = 0; return; }
      this.nativeLen = this.stereo
        ? this.sequencer.renderStereo(this.nativeL, this.nativeR, 0, this.nativeL.length)
        : this.sequencer.render(this.nativeL, 0, this.nativeL.length);
      this.nativePos = 0;
      if (this.nativeLen === 0) { this.prevL = this.prevR = 0; return; }
      if (this.toneMode === "standard") this.#smooth();
    }
    this.prevL = this.nativeL[this.nativePos];
    this.prevR = this.nativeR[this.nativePos];
    this.nativePos++;
  }

  /** The standard tone's low-pass, over the block just rendered, in place. */
  #smooth() {
    const f = this.filter;
    const run = (buf, at) => {
      let x1 = f[at], y1 = f[at + 1];
      for (let i = 0; i < this.nativeLen; i++) {
        const x = buf[i];
        y1 = STANDARD_B * (x + x1) + STANDARD_A * y1;
        x1 = x;
        buf[i] = y1;
      }
      f[at] = x1; f[at + 1] = y1;
    };
    run(this.nativeL, 0);
    if (this.nativeR !== this.nativeL) run(this.nativeR, 2);
  }

  /**
   * Resample the chip's stream into one or two caller buffers.
   * `right` null means mono, and on a stereo chip that is a downmix.
   */
  #resample(out, right, offset, count) {
    const clamp = (v) => Math.fround(v > 1 ? 1 : v < -1 ? -1 : v);
    for (let i = 0; i < count; i++) {
      // Linear interpolation between chip samples: the chip's 49716 Hz is not
      // a neat ratio of any audio device's rate.
      while (this.frac >= 1) { this.#advance(); this.frac -= 1; }
      const more = this.nativePos < this.nativeLen;
      const nextL = more ? this.nativeL[this.nativePos] : this.prevL;
      const nextR = more ? this.nativeR[this.nativePos] : this.prevR;
      const l = (this.prevL + (nextL - this.prevL) * this.frac) * this.gain;
      const r = (this.prevR + (nextR - this.prevR) * this.frac) * this.gain;
      if (right) {
        out[offset + i] = clamp(l);
        right[offset + i] = clamp(r);
      } else {
        // A centred voice is in both buses, so on a song that never pans this
        // is the mono mix exactly; only a panned voice is the 3 dB down that
        // any mono fold of a stereo mix costs it.
        out[offset + i] = clamp(this.stereo ? (l + r) / 2 : l);
      }
      this.frac += this.ratio;
    }
  }

  /**
   * Fill `out` with mono samples at the requested rate. Returns false once the
   * song has finished and the buffer has been zero-filled.
   *
   * @param {Float32Array} out
   * @param {number} [offset]
   * @param {number} [count]
   * @returns {boolean} false once the song has finished
   */
  render(out, offset = 0, count = out.length - offset) {
    if (this.ended) { out.fill(0, offset, offset + count); return false; }
    this.#resample(out, null, offset, count);
    return true;
  }

  /**
   * Fill both channels. On a YM3812 that is the mono output twice; on a YMF262
   * it is what the songs's panning asks for (SOP §4.2), which is the whole
   * reason this method is not just `render` copied.
   *
   * @param {Float32Array} left
   * @param {Float32Array} right
   * @param {number} [offset]
   * @param {number} [count]
   * @returns {boolean}
   */
  renderStereo(left, right, offset = 0, count = left.length - offset) {
    if (this.ended) {
      left.fill(0, offset, offset + count);
      right.fill(0, offset, offset + count);
      return false;
    }
    if (!this.stereo || this.monoMix) {
      this.#resample(left, null, offset, count);
      right.set(left.subarray(offset, offset + count), offset);
      return true;
    }
    this.#resample(left, right, offset, count);
    return true;
  }

  /**
   * Render the whole song to one array, capped at `maxSeconds`.
   * @param {number} [maxSeconds]
   * @returns {Float32Array}
   */
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
   *
   * @param {number} [tick] in the cues' own unit, as `lyricTick` gives it
   * @returns {LyricSpan|null}
   */
  lyricAt(tick = this.lyricTick) {
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
