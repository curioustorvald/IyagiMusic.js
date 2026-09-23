// Turning a parsed song into driver calls, on a sample-accurate clock.
//
// Both formats reduce to the same thing: a stream of events carrying absolute
// tick positions, plus a tempo that events may change. The sequencer owns the
// clock (docs/ENGINE_SPEC.en.md §9) and the driver owns the chip.

import { AdlibDriver, BD, MID_PITCH } from "./driver.js";
import { imsEvents, sopPatch } from "./formats.js";
import {
  NATIVE_RATE, METER_VOICES, RHYTHM_VOICES,
  PAN_LEFT, PAN_RIGHT, PAN_CENTRE,
} from "./opl/constants.js";

/** Event kinds a sequencer understands. */
export const NOTE_ON = 0, NOTE_OFF = 1, VOLUME = 2, PATCH = 3, BEND = 4,
  TEMPO = 5, END = 6, PAN = 7;

/** @typedef {import("./formats.js").Patch} Patch */

/**
 * One instruction for the driver, at an absolute tick. Both formats reduce to
 * this: `type` says which of the constants above it is, and the rest of the
 * fields are whichever that kind uses.
 *
 * @typedef {object} SeqEvent
 * @property {number} tick
 * @property {number} type one of NOTE_ON..END
 * @property {number} [voice]
 * @property {number} [note] MIDI note number
 * @property {number} [volume] 0..127
 * @property {number|Patch} [patch] an index into `patches` (IMS) or the patch itself (ROL)
 * @property {number} [bend] 14-bit, 0x2000 centred -- or, for a SOP, the file's
 *   own pitch, 0..200 about 100
 * @property {number} [pan] one of the PAN_* values; ignored by a mono chip
 * @property {number} [garble] SOP: 0xC0 bits a corrupt pan value damages (SOP §4.2)
 * @property {boolean} [legato] SOP: a NOTE_ON that slurs from the note before
 *   it on the same voice rather than striking again (SOP §4.2)
 * @property {boolean} [wide] SOP: a PATCH for a voice whose channel pair is joined
 * @property {number} [tempo] beats per minute
 * @property {number} [order] tie-break within a tick, for ROL's parallel tracks
 */

/**
 * A song's length and where its ticks fall in time, at its own tempo.
 * @typedef {object} Timeline
 * @property {number} endTick where the song ends
 * @property {number} duration seconds from the start to `endTick`
 * @property {(tick:number)=>number} secondsAt
 * @property {(seconds:number)=>number} tickAt
 */

export class Sequencer {
  /**
   * @param {object} opts
   * @param {{write(reg:number,value:number):void}} opts.chip
   * @param {Iterable<SeqEvent>} opts.events  absolute-tick events, in order
   * @param {number} opts.tickBeat          ticks per beat
   * @param {number} opts.tempo             beats per minute
   * @param {boolean} opts.percussive
   * @param {number} [opts.pitchRange]
   * @param {(Patch|null)[]} [opts.patches] resolved bank patches, by index
   * @param {number} [opts.sampleRate]      defaults to the chip's native rate
   * @param {boolean} [opts.opl3]           drive the chip as a YMF262;
   *   defaults to whatever the chip says it is
   * @param {boolean} [opts.mirror]         drive an OPL3 as IMPLAY does for
   *   stereo (ENGINE_SPEC §11.1): the nine-voice layout, doubled
   * @param {boolean} [opts.sop]            play `sopSequence` events the way
   *   NOTE.EXE does (SOP §8.1); the driver takes SOP pitches and joins pairs
   *   as the events say
   */
  constructor(opts) {
    this.chip = opts.chip;
    this.driver = new AdlibDriver(opts.chip, {
      opl3: opts.mirror ? false : (opts.opl3 ?? !!opts.chip.opl3),
      sop: !!opts.sop, mirror: !!opts.mirror,
    });
    this.makeEvents = opts.events;
    this.tickBeat = opts.tickBeat || 240;
    this.baseTempo = opts.tempo || 120;
    this.percussive = !!opts.percussive;
    this.pitchRange = opts.pitchRange ?? 1;
    this.patches = opts.patches ?? [];
    this.sampleRate = opts.sampleRate ?? NATIVE_RATE;
    this.loop = false;
    /**
     * Playback speed as a multiple of the song's own tempo. IMPLAY's `<` and
     * `>` (ENGINE_SPEC §13). It survives `reset`, as a listener's setting
     * should, and it is not the song's tempo: `tempo` stays what the file says.
     * @type {number}
     */
    this.speed = 1;
    /**
     * Semitones added to every note a melodic voice starts -- IMPLAY's key
     * shift (ENGINE_SPEC §13), except that the drums are left alone. Like
     * IMPLAY's, it reaches the next note struck rather than the ones already
     * sounding. Survives `reset`.
     * @type {number}
     */
    this.transpose = 0;
    /** @type {Timeline|null} built on first use; see `timeline` */
    this.timelineCache = null;
    this.reset();
  }

  /**
   * Change the speed without a jump: what is left of the gap to the next
   * event is rescaled, so the change is heard from the next sample rather
   * than from the next event.
   * @param {number} speed a multiple of the song's tempo; must be positive
   */
  setSpeed(speed) {
    if (!(speed > 0)) throw new RangeError(`speed must be positive, not ${speed}`);
    if (this.sampleCursor > 0) this.sampleCursor *= this.speed / speed;
    this.speed = speed;
  }

  reset() {
    this.driver.reset();
    this.driver.setMode(this.percussive);
    this.driver.setPitchRange(this.pitchRange);
    /** @type {number} */
    this.tempo = this.baseTempo;
    this.iterator = this.makeEvents[Symbol.iterator]();
    this.pending = this.iterator.next();
    /** @type {number} */
    this.tick = 0;
    this.sampleCursor = 0;      // fractional samples owed before the next event
    this.samplesRendered = 0;
    /**
     * Samples of *song* time so far: what `samplesRendered` would be at speed
     * 1. It is what a clock or a progress bar wants, because it lines up with
     * `timeline()` whatever the speed has been.
     */
    this.songSamples = 0;
    /** @type {boolean} */
    this.ended = false;
    // What each voice is currently set to, for anything showing the player
    // its own state. The epoch saves a display from diffing eleven strings a
    // frame when patch changes are a handful an entire song.
    /** @type {string[]} */
    this.voicePatchName = new Array(METER_VOICES).fill("");
    /** @type {number} */
    this.patchEpoch = (this.patchEpoch | 0) + 1;   // never repeats, so a reset shows
  }

  /** Seconds per tick at the current tempo and speed. */
  get tickSeconds() {
    return 60 / (this.tempo * this.tickBeat * this.speed);
  }

  /**
   * The song's length and its tick-to-time map, at its own tempo. Built by
   * reading the events through once, which for any song in the corpus is a
   * few milliseconds, and kept.
   *
   * The end is the END event's tick -- or, for an `.ims` with no FC, where
   * the sequence's closing END sits at the end of time, the last real event's.
   *
   * @returns {Timeline}
   */
  timeline() {
    if (this.timelineCache) return this.timelineCache;
    const steps = [{ tick: 0, seconds: 0, tempo: this.baseTempo }];
    let last = 0, end = -1;
    for (const ev of this.makeEvents) {
      if (ev.type === END) { end = ev.tick >= Number.MAX_SAFE_INTEGER ? last : ev.tick; break; }
      last = ev.tick;
      if (ev.type !== TEMPO) continue;
      const prev = steps[steps.length - 1];
      const seconds = prev.seconds + (ev.tick - prev.tick) * 60 / (prev.tempo * this.tickBeat);
      steps.push({ tick: ev.tick, seconds, tempo: ev.tempo });
    }
    if (end < 0) end = last;
    const secondsAt = (tick) => {
      let i = steps.length - 1;
      while (i > 0 && steps[i].tick > tick) i--;
      const s = steps[i];
      return s.seconds + (tick - s.tick) * 60 / (s.tempo * this.tickBeat);
    };
    const tickAt = (seconds) => {
      let i = steps.length - 1;
      while (i > 0 && steps[i].seconds > seconds) i--;
      const s = steps[i];
      return Math.max(0, Math.round(s.tick + (seconds - s.seconds) * s.tempo * this.tickBeat / 60));
    };
    this.timelineCache = { endTick: end, duration: secondsAt(end), secondsAt, tickAt };
    return this.timelineCache;
  }

  /**
   * Jump to `tick`, as IMPLAY does (ENGINE_SPEC §13): start the song over,
   * run every event before `tick` without making a sound, and carry on from
   * there. Whatever those events leave behind -- patches, volumes, bends,
   * tempo -- is exactly what a listener who had played that far would have,
   * and a note still held at `tick` was keyed during the run and so starts
   * again from its attack. IMPLAY meant to do that too and does not: its
   * seek leaves every voice silent until the next note (ENGINE_SPEC §13).
   *
   * The caller resets the chip first; the driver's reset only rewrites it.
   *
   * @param {number} tick
   */
  seek(tick) {
    const target = Math.max(0, Math.floor(tick));
    this.reset();
    while (!this.pending.done && this.pending.value.tick < target) {
      this.#apply(this.pending.value);
      this.pending = this.iterator.next();
      if (this.ended) return;
    }
    this.tick = target;
    this.samplesRendered = this.songSamples =
      Math.round(this.timeline().secondsAt(target) * this.sampleRate);
  }

  /** How far through the song we are, in seconds. */
  get seconds() {
    return this.samplesRendered / this.sampleRate;
  }

  #apply(ev) {
    const d = this.driver;
    switch (ev.type) {
      case NOTE_ON:
        // A slur keeps the key down, so the note changes pitch unstruck.
        if (!ev.legato) d.noteOff(ev.voice);
        if (ev.volume !== undefined) d.setVoiceVolume(ev.voice, ev.volume);
        // The key shift is for singing along to, and a drum has no key: IMPLAY
        // moves its drums too, which only detunes the kit.
        d.noteOn(ev.voice, ev.voice < d.melodicVoices ? ev.note + this.transpose : ev.note);
        break;
      case NOTE_OFF:
        d.noteOff(ev.voice);
        break;
      case VOLUME:
        d.setVoiceVolume(ev.voice, ev.volume);
        break;
      case PATCH: {
        // IMS carries an index into the song's patch table; ROL has already
        // resolved a name to the patch itself.
        const patch = typeof ev.patch === "number" ? this.patches[ev.patch] : ev.patch;
        if (!patch) break;
        d.setVoiceTimbre(ev.voice, patch, ev.wide);
        const name = patch.name ?? "";
        if (this.voicePatchName[ev.voice] !== name) {
          this.voicePatchName[ev.voice] = name;
          this.patchEpoch++;
        }
        break;
      }
      case BEND:
        d.setVoicePitch(ev.voice, ev.bend);
        break;
      case PAN:
        d.setVoicePan(ev.voice, ev.pan, ev.garble);
        break;
      case TEMPO:
        this.tempo = ev.tempo;
        break;
      case END:
        this.ended = true;
        break;
      default:
        break;
    }
  }

  /** Run every event due at or before the current tick. */
  #drain() {
    while (!this.pending.done) {
      const ev = this.pending.value;
      if (ev.tick > this.tick) return;
      this.#apply(ev);
      this.pending = this.iterator.next();
      if (this.ended) {
        if (this.loop) { this.#restart(); continue; }
        return;
      }
    }
    this.ended = true;
  }

  #restart() {
    this.iterator = this.makeEvents[Symbol.iterator]();
    this.pending = this.iterator.next();
    this.tick = 0;
    this.songSamples = 0;
    this.ended = false;
    this.tempo = this.baseTempo;
    for (let v = 0; v < this.driver.voiceCount; v++) this.driver.noteOff(v);
  }

  /**
   * Render `count` samples of the song into `out` at `offset`.
   * Returns the number of samples actually written -- short only at the end
   * of a non-looping song.
   *
   * @param {Float32Array} out
   * @param {number} offset
   * @param {number} count
   * @returns {number}
   */
  render(out, offset, count) {
    return this.#run(out, null, offset, count);
  }

  /**
   * The same, as two channels. Only a chip with the stereo switches has
   * anything different to put in them; see `OplChip.generateStereo`.
   *
   * @param {Float32Array} left @param {Float32Array} right
   * @param {number} offset @param {number} count
   * @returns {number}
   */
  renderStereo(left, right, offset, count) {
    return this.#run(left, right, offset, count);
  }

  #run(out, right, offset, count) {
    let written = 0;
    while (written < count) {
      if (this.sampleCursor <= 0) {
        if (this.ended) break;
        this.#drain();
        if (this.ended) break;
        // Advance to the next event's tick and bank the samples it is worth.
        const nextTick = this.pending.done ? this.tick + 1 : this.pending.value.tick;
        const deltaTicks = Math.max(1, nextTick - this.tick);
        this.sampleCursor += deltaTicks * this.tickSeconds * this.sampleRate;
        this.tick = nextTick;
      }
      const run = Math.min(count - written, Math.max(1, Math.floor(this.sampleCursor)));
      if (right) this.chip.generateStereo(out, right, offset + written, run);
      else this.chip.generate(out, offset + written, run);
      this.sampleCursor -= run;
      this.samplesRendered += run;
      this.songSamples += run * this.speed;
      written += run;
    }
    if (written < count) {
      out.fill(0, offset + written, offset + count);
      if (right) right.fill(0, offset + written, offset + count);
    }
    return written;
  }
}

/**
 * Flatten an IMS song into sequencer events. §1.4 of the formats doc.
 * @param {import("./formats.js").ImsSong} song
 * @returns {Generator<SeqEvent, void, undefined>}
 */
export function* imsSequence(song) {
  const melodicOnly = !song.percussive;
  // §1.5: the song ends at totalTick, or at FC if that comes first -- as in
  // IMPLAY, which reads no event once its tick counter has reached totalTick.
  // Where the two disagree, what lies past totalTick in the corpus is silence
  // or damage -- or, in D-PRODC#.IMS alone, a closing passage behind a
  // seven-minute held note that IMPLAY never reached. A totalTick of 0 or
  // less would end IMPLAY before the
  // first note; no file has one, and this plays to FC rather than to nothing.
  const stop = song.totalTick > 0 ? song.totalTick : Number.MAX_SAFE_INTEGER;
  for (const ev of imsEvents(song)) {
    const status = ev.status;
    if (ev.tick >= stop) { yield { tick: stop, type: END }; return; }
    if (status === 0xfc) { yield { tick: ev.tick, type: END }; return; }
    if (status === 0xf0) {
      yield { tick: ev.tick, type: TEMPO, tempo: song.tempo * (ev.a + ev.b / 128) };
      continue;
    }
    const voice = status & 0x0f;
    // §1.7: channels the current mode does not have are discarded outright.
    if (voice > (melodicOnly ? 8 : 10)) continue;
    switch (status & 0xf0) {
      case 0x80:
        // §1.4: the guarded reading -- retrigger only when the byte is non-zero.
        if (ev.b > 0) yield { tick: ev.tick, type: NOTE_ON, voice, note: ev.a, volume: ev.b };
        else yield { tick: ev.tick, type: NOTE_OFF, voice };
        break;
      case 0x90:
        if (ev.b > 0) yield { tick: ev.tick, type: NOTE_ON, voice, note: ev.a, volume: ev.b };
        else yield { tick: ev.tick, type: NOTE_OFF, voice };
        break;
      case 0xa0:
        yield { tick: ev.tick, type: VOLUME, voice, volume: ev.a };
        break;
      case 0xc0:
        yield { tick: ev.tick, type: PATCH, voice, patch: ev.a };
        break;
      case 0xe0:
        yield { tick: ev.tick, type: BEND, voice, bend: ev.a | (ev.b << 7) };
        break;
      default:
        break;                                        // B0 and D0 are ignored
    }
  }
  // A stream that runs out without FC -- only damaged files do (§1.5) --
  // still ends where IMPLAY's counter would.
  yield { tick: stop, type: END };
}

/**
 * Flatten a ROL song into sequencer events. §3 of the formats doc.
 * `resolve` maps an instrument name to a bank patch; unresolved names are
 * dropped rather than silencing the voice.
 *
 * @param {import("./formats.js").RolSong} song
 * @param {(name: string) => (Patch|null)} resolve
 * @returns {SeqEvent[]}
 */
export function rolSequence(song, resolve) {
  const out = [];
  const voiceLimit = song.percussive ? 11 : 9;
  for (const e of song.tempoTrack.events) {
    out.push({ tick: e.tick, type: TEMPO, tempo: song.tempoTrack.tempo * e.multiplier, order: 0 });
  }
  for (let v = 0; v < Math.min(voiceLimit, song.voices.length); v++) {
    const voice = song.voices[v];
    for (const t of voice.timbres) {
      const patch = resolve(t.name);
      if (patch) out.push({ tick: t.tick, type: PATCH, voice: v, patch, order: 1 });
    }
    for (const e of voice.volumes) {
      out.push({ tick: e.tick, type: VOLUME, voice: v, volume: Math.round(e.volume * 127), order: 2 });
    }
    for (const e of voice.pitches) {
      out.push({ tick: e.tick, type: BEND, voice: v, bend: Math.round(e.pitch * 0x2000), order: 2 });
    }
    for (const n of voice.notes) {
      if (n.note === 0) continue;                       // a rest
      out.push({ tick: n.tick, type: NOTE_ON, voice: v, note: n.note, order: 3 });
      out.push({ tick: n.tick + n.duration, type: NOTE_OFF, voice: v, order: 4 });
    }
  }
  // Tempo, then patch, then volume/pitch, then notes -- so that a note landing
  // on the same tick as its own setup hears the new settings.
  out.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const last = out.length ? out[out.length - 1].tick : 0;
  out.push({ tick: last + 1, type: END, order: 9 });
  return out;
}

/**
 * The voice layout `sopSequence` writes for when it is given none: a YM3812,
 * which is what this library ran a SOP on before there was an OPL3 core.
 * @param {import("./formats.js").SopSong} song
 */
function opl2Layout(song) {
  return {
    melodicVoices: song.percussive ? BD : 9,
    rhythmBase: BD,
    fourOpPairs: [],
  };
}

/**
 * SOP §4.2 panning, as NOTE.EXE does it. 0, 1 and 2 are right, both and left.
 * Any other value Note writes into 0xC0 as it stands: its bits 4 and 5 become
 * the stereo switches -- both clear, for every such value in the corpus, which
 * silences the channel -- and its low nibble is ORed into the channel's
 * feedback and connection until the next patch.
 * @param {number} value
 * @returns {{pan:number, garble:number}}
 */
function sopPan(value) {
  if (value === 0) return { pan: PAN_RIGHT, garble: 0 };
  if (value === 1) return { pan: PAN_CENTRE, garble: 0 };
  if (value === 2) return { pan: PAN_LEFT, garble: 0 };
  return { pan: (value >> 4) & 3, garble: value & 0x0f };
}

/** The PC's programmable interval timer counts at this, in Hz. */
const PIT_HZ = 1193182;

/**
 * SOP §5: the tempo, in bpm, that Note really plays a SOP tempo of `bpm` at.
 *
 * Note runs the timer at 4 × bpm interrupts a second, 240 to the beat, and
 * steps the song one tick every 240 ÷ tickBeat of them, in integers. The
 * timer divisor rounds down, so 120 bpm comes out at 120.04; a rate under
 * 19 Hz cannot be set at all and leaves the timer at its 18.2 Hz default, so
 * tempos 2..4 play at about 4.55 bpm; and a tickBeat that does not divide 240
 * runs slightly fast.
 *
 * @param {number} bpm @param {number} tickBeat
 * @returns {number}
 */
export function sopTempo(bpm, tickBeat) {
  const rate = bpm * 4;
  const divisor = rate < 19 ? 65536 : Math.floor(PIT_HZ / rate);
  const interruptsPerTick = Math.max(1, Math.floor(240 / tickBeat));
  return ((PIT_HZ / divisor) / interruptsPerTick) * 60 / tickBeat;
}

/** SOP §4.2: Note's volume for a track that has not had a volume event yet. */
const SOP_DEFAULT_VOLUME = 96;

/**
 * Flatten a SOP song into sequencer events, the way NOTE.EXE plays it. SOP §8.
 *
 * The events are for a `Sequencer` given `sop: true`, whose driver speaks
 * SOP's own units: a BEND carries the file's pitch, 0..200 about 100, and a
 * PATCH says whether its voice's channel pair is joined.
 *
 * `layout` says what the chip underneath actually has, and everything that
 * follows is a consequence of it:
 *
 * - **Rhythm tracks keep their voice.** In percussive mode, track slots 6..10
 *   are the bass drum, snare, tom, cymbal and hi-hat (SOP §4.1), and those map
 *   one to one onto the five rhythm voices wherever the chip puts them --
 *   6..10 on a YM3812, 15..19 on a YMF262. In melodic mode tracks 9 and 10 are
 *   no channel at all to Note, and are dropped.
 * - **A mode-1 track gets a four-operator voice; nothing else does.** Note
 *   joins a pair because the channel-mode table says so (SOP §2) and never
 *   because of the instrument: a four-operator instrument elsewhere plays its
 *   first pair, and a two-operator one on a joined pair loads into the first
 *   pair and leaves the second as it was (SOP §3.3). The voice is fixed for
 *   the whole song, since joining a pair is a register write that reaches both
 *   channels.
 * - **Mode-0 tracks are not played.** They are the silent upper halves of
 *   those pairs (SOP §2). Bit 7 of the mode is the editor's disable switch,
 *   and is the one place this does not follow Note: it is screen state -- two
 *   corpus files were saved with solo on -- so those tracks are played.
 * - **Everything else shares what is left**, allocated per note. A track keeps
 *   its voice while its note sounds; when every voice is busy the one whose
 *   note ends soonest is cut short. On a YMF262 the voices left over are
 *   exactly as many as the tracks left over, so nothing is ever cut there --
 *   which is Note's own layout, a track to a channel, by another route.
 * - **A note that starts while the track's last one sounds is a slur**: the
 *   pitch moves and the note is not struck again, and on a drum the hit is
 *   silent (SOP §4.2). A note that starts where the last one ends is struck.
 * - **Panning is a voice setting**, so it is emitted per voice rather than per
 *   track, and lands wherever the track's notes landed. A mono chip drops it,
 *   except for what a corrupt value does to feedback.
 *
 * @param {import("./formats.js").SopSong} song
 * @param {{melodicVoices:number, rhythmBase:number, fourOpPairs:number[][]}} [layout]
 * @returns {SeqEvent[]}
 */
export function sopSequence(song, layout) {
  const percussive = song.percussive;
  const plan = layout ?? opl2Layout(song);
  const melodicVoices = plan.melodicVoices;
  const rhythmBase = plan.rhythmBase;
  const voiceSlots = Math.max(melodicVoices, rhythmBase + RHYTHM_VOICES);
  const patches = song.instruments.map(sopPatch);
  const nTracks = song.tracks.length;

  // §4.1: the five rhythm tracks are track slots 6..10 whatever the chip is.
  // Those are numbers the format fixes, not the chip.
  const rhythmVoiceOf = (t) =>
    (percussive && t >= 6 && t < 6 + RHYTHM_VOICES ? rhythmBase + (t - 6) : -1);
  // §2 and §4.1: which tracks Note plays at all.
  const plays = (t) => song.tracks[t].mode !== 0 && (percussive || (t !== 9 && t !== 10));

  // §2: hand the four-operator channel pairs to the mode-1 tracks, in track
  // order. Only tracks 0, 1, 2, 11, 12 and 13 can be mode 1, so an OPL3 always
  // has a pair for each; an OPL2 has none, and they fall back to two operators.
  const wideOf = new Array(nTracks).fill(-1);
  const spokenFor = new Set();
  const pairs = (plan.fourOpPairs ?? [])
    .filter(([head, slave]) => head < melodicVoices && slave < melodicVoices);
  const asking = [];
  for (let t = 0; t < nTracks; t++) {
    if (plays(t) && rhythmVoiceOf(t) < 0 && song.tracks[t].mode === 1) asking.push(t);
  }
  asking.slice(0, pairs.length).forEach((t, i) => {
    const [head, slave] = pairs[i];
    wideOf[t] = head;
    spokenFor.add(head);
    spokenFor.add(slave);
  });
  /** The voices left for ordinary two-operator notes to share. */
  const pool = [];
  for (let v = 0; v < melodicVoices; v++) if (!spokenFor.has(v)) pool.push(v);
  const wideVoices = new Set(wideOf.filter((v) => v >= 0));

  // Merge every track with the control track, keeping file order inside each.
  // Array.prototype.sort is stable, so sorting on (tick, source) alone leaves
  // a track's own events in the order it stored them -- which matters, because
  // a SOP sets the patch, volume and pitch of a note in the tick before it.
  const merged = [];
  for (const ev of song.control) merged.push({ ev, track: -1, source: 0 });
  for (let t = 0; t < nTracks; t++) {
    if (!plays(t)) continue;
    for (const ev of song.tracks[t].events) merged.push({ ev, track: t, source: 1 });
  }
  merged.sort((a, b) => a.ev.tick - b.ev.tick || a.source - b.source);

  const out = [];
  let globalVolume = 127;
  const trackPatch = new Array(nTracks).fill(-1);
  const trackVolume = new Array(nTracks).fill(SOP_DEFAULT_VOLUME);
  const trackBend = new Array(nTracks).fill(100);     // §4.2: 100 is centre
  const trackPan = new Array(nTracks).fill(-1);
  const trackVoice = new Array(nTracks).fill(-1);
  const touched = new Array(nTracks).fill(false);
  const voiceTrack = new Array(voiceSlots).fill(-1);
  const voiceEnd = new Int32Array(voiceSlots);
  const voicePan = new Array(voiceSlots).fill(-1);
  /** The note-off already emitted for each voice, so that a steal or a slur can move it. */
  const voiceOff = new Array(voiceSlots).fill(null);
  // -2 is "nothing loaded". §4.2: Note's default instrument is slot 0, and in
  // every corpus track that relies on it slot 0 holds one. A file whose slot 0
  // is empty would leave Note playing on reset registers; this library stands
  // in the first instrument that yields a patch instead, rather than be silent.
  const voicePatch = new Array(voiceSlots).fill(-2);
  const defaultIndex = patches[0] ? 0 : patches.findIndex((p) => p);

  // §5: global volume scales track volume, in integers as Note does it.
  const volumeOf = (t) => Math.floor((trackVolume[t] * globalVolume) / 127);

  const emitVolume = (tick, voice, t) =>
    out.push({ tick, type: VOLUME, voice, volume: volumeOf(t), order: 2 });
  /** Panning belongs to the voice, so it is only worth sending when it moves. */
  const emitPan = (tick, voice, t) => {
    if (trackPan[t] < 0 || voicePan[voice] === trackPan[t]) return;
    const { pan, garble } = sopPan(trackPan[t]);
    // A corrupt value damages 0xC0 each time it is written, so it is never
    // "already set".
    voicePan[voice] = garble ? -1 : trackPan[t];
    out.push({ tick, type: PAN, voice, pan, garble, order: 2 });
  };
  const emitPatch = (tick, voice, index) => {
    out.push({ tick, type: PATCH, voice, patch: patches[index], wide: wideVoices.has(voice), order: 1 });
    voicePatch[voice] = index;
  };

  /** The voice a track owns outright: a drum's, or a four-operator one. */
  const fixedVoiceOf = (t) => {
    const rhythm = rhythmVoiceOf(t);
    return rhythm >= 0 ? rhythm : wideOf[t];
  };

  /** A voice for a melodic track's note: its own, a free one, or a stolen one. */
  const allocate = (t, tick) => {
    const own = trackVoice[t];
    if (own >= 0 && voiceTrack[own] === t) return own;
    for (const v of pool) if (voiceTrack[v] < 0 || voiceEnd[v] <= tick) return v;
    let best = pool[0];
    for (const v of pool) if (voiceEnd[v] < voiceEnd[best]) best = v;
    return best;
  };

  let lastTick = 0;
  for (const { ev, track } of merged) {
    lastTick = ev.tick;
    if (track < 0) {
      if (ev.code === 3) {                                   // §5: tempo, in bpm
        out.push({ tick: ev.tick, type: TEMPO, tempo: sopTempo(ev.value, song.tickBeat), order: 0 });
      } else if (ev.code === 8) {                            // §5: global volume
        globalVolume = ev.value;
        for (let t = 0; t < nTracks; t++) {
          if (!touched[t]) continue;
          const voice = fixedVoiceOf(t);
          if (voice >= 0) emitVolume(ev.tick, voice, t);
          else if (trackVoice[t] >= 0 && voiceTrack[trackVoice[t]] === t) {
            emitVolume(ev.tick, trackVoice[t], t);
          }
        }
      }
      continue;
    }
    touched[track] = true;
    const fixed = fixedVoiceOf(track);
    const held = fixed >= 0
      ? fixed
      : (trackVoice[track] >= 0 && voiceTrack[trackVoice[track]] === track
        ? trackVoice[track] : -1);

    switch (ev.code) {
      case 6:                                                // §4.2: instrument
        // An empty slot loads nothing in Note, so the last instrument stays.
        if (!patches[ev.value]) break;
        trackPatch[track] = ev.value;
        if (held >= 0 && voicePatch[held] !== ev.value) emitPatch(ev.tick, held, ev.value);
        break;
      case 4:                                                // §4.2: volume
        trackVolume[track] = ev.value;
        if (held >= 0) emitVolume(ev.tick, held, track);
        break;
      case 5:                                                // §4.2: pitch
        trackBend[track] = ev.value;
        if (held >= 0) out.push({ tick: ev.tick, type: BEND, voice: held, bend: ev.value, order: 2 });
        break;
      case 7:                                                // §4.2: panning
        trackPan[track] = ev.value;
        if (held >= 0) emitPan(ev.tick, held, track);
        break;
      case 2: {                                              // §4.2: note on
        // §4.2 gives a note its length up front, which is what makes a static
        // allocator possible at all: the sequencer knows when each voice frees.
        const length = Math.max(1, ev.length ?? 1);
        const endTick = ev.tick + length;
        let voice = fixed;
        let ownedBefore = fixed >= 0;
        if (voice < 0) {
          voice = allocate(track, ev.tick);
          const previous = voiceTrack[voice];
          ownedBefore = previous === track;
          if (previous >= 0 && previous !== track) trackVoice[previous] = -1;
          voiceTrack[voice] = track;
          trackVoice[track] = voice;
        }
        voiceEnd[voice] = endTick;
        const pending = voiceOff[voice];
        // §4.2: this track's own note still sounding makes this a slur, and its
        // note-off goes; anyone else's is a steal, and its note-off comes
        // forward to now so the voice is free in time.
        const legato = ownedBefore && !!pending && pending.tick > ev.tick;
        if (legato) pending.dead = true;
        else if (pending && pending.tick > ev.tick) pending.tick = ev.tick;
        const chosen = trackPatch[track] >= 0 ? trackPatch[track] : defaultIndex;
        if (chosen >= 0 && voicePatch[voice] !== chosen) emitPatch(ev.tick, voice, chosen);
        emitVolume(ev.tick, voice, track);
        emitPan(ev.tick, voice, track);
        out.push({ tick: ev.tick, type: BEND, voice, bend: trackBend[track], order: 2 });
        out.push({ tick: ev.tick, type: NOTE_ON, voice, note: ev.value, legato, order: 4 });
        const off = { tick: endTick, type: NOTE_OFF, voice, order: 3 };
        out.push(off);
        voiceOff[voice] = off;
        break;
      }
      default:
        // §4.2: 1 is the "special event", a sync marker for other programs.
        // Note's own player ignores it, so dropping it is what Note does.
        break;
    }
  }

  // Tempo, then patch, then volume and pitch, then note-offs, then note-ons --
  // so a note hears its own setup, so a note that starts where the last one
  // ends is struck again, and so a voice taken back from another track is
  // released before it is keyed again.
  const kept = out.filter((e) => !e.dead);
  kept.sort((a, b) => a.tick - b.tick || a.order - b.order);
  // The end comes off the sorted array, not off the last event read: a note
  // started on the final tick still has its length to run, and ending the song
  // at the last *input* tick would cut it off.
  const last = kept.length ? kept[kept.length - 1].tick : lastTick;
  kept.push({ tick: last + 1, type: END, order: 9 });
  return kept;
}
