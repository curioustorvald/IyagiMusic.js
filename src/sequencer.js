// Turning a parsed song into driver calls, on a sample-accurate clock.
//
// Both formats reduce to the same thing: a stream of events carrying absolute
// tick positions, plus a tempo that events may change. The sequencer owns the
// clock (docs/ENGINE_SPEC.en.md §9) and the driver owns the chip.

import { AdlibDriver, BD, HH, MID_PITCH } from "./driver.js";
import { imsEvents, sopPatch } from "./formats.js";
import { NATIVE_RATE } from "./opl/constants.js";

/** Event kinds a sequencer understands. */
export const NOTE_ON = 0, NOTE_OFF = 1, VOLUME = 2, PATCH = 3, BEND = 4,
  TEMPO = 5, END = 6;

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
 * @property {number} [bend] 14-bit, 0x2000 centred
 * @property {number} [tempo] beats per minute
 * @property {number} [order] tie-break within a tick, for ROL's parallel tracks
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
   */
  constructor(opts) {
    this.chip = opts.chip;
    this.driver = new AdlibDriver(opts.chip);
    this.makeEvents = opts.events;
    this.tickBeat = opts.tickBeat || 240;
    this.baseTempo = opts.tempo || 120;
    this.percussive = !!opts.percussive;
    this.pitchRange = opts.pitchRange ?? 1;
    this.patches = opts.patches ?? [];
    this.sampleRate = opts.sampleRate ?? NATIVE_RATE;
    this.loop = false;
    this.reset();
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
    /** @type {boolean} */
    this.ended = false;
    // What each voice is currently set to, for anything showing the player
    // its own state. The epoch saves a display from diffing eleven strings a
    // frame when patch changes are a handful an entire song.
    /** @type {string[]} */
    this.voicePatchName = new Array(11).fill("");
    /** @type {number} */
    this.patchEpoch = (this.patchEpoch | 0) + 1;   // never repeats, so a reset shows
  }

  /** Seconds per tick at the current tempo. */
  get tickSeconds() {
    return 60 / (this.tempo * this.tickBeat);
  }

  /** How far through the song we are, in seconds. */
  get seconds() {
    return this.samplesRendered / this.sampleRate;
  }

  #apply(ev) {
    const d = this.driver;
    switch (ev.type) {
      case NOTE_ON:
        d.noteOff(ev.voice);
        if (ev.volume !== undefined) d.setVoiceVolume(ev.voice, ev.volume);
        d.noteOn(ev.voice, ev.note);
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
        d.setVoiceTimbre(ev.voice, patch);
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
    this.ended = false;
    this.tempo = this.baseTempo;
    for (let v = 0; v <= (this.percussive ? HH : 8); v++) this.driver.noteOff(v);
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
      this.chip.generate(out, offset + written, run);
      this.sampleCursor -= run;
      this.samplesRendered += run;
      written += run;
    }
    if (written < count) out.fill(0, offset + written, offset + count);
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
  for (const ev of imsEvents(song)) {
    const status = ev.status;
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
  yield { tick: Number.MAX_SAFE_INTEGER, type: END };
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
 * Flatten a SOP song into sequencer events. SOP §8.
 *
 * This is the one place in the library that knowingly plays something other
 * than what the file says, so it is worth being blunt about why. SOP is an
 * **OPL3** format: twenty voices, four-operator instruments, stereo panning.
 * The chip under this library is an OPL2 with nine voices, or six plus the
 * five rhythm instruments. The format does not fit, and 298 of the 336 corpus
 * files ask for more melodic voices than an OPL2 has -- 114 of them use all
 * twenty tracks. So this is a reduction, not a rendering:
 *
 * - **Rhythm tracks keep their voice.** In percussive mode, track slots 6..10
 *   are the bass drum, snare, tom, cymbal and hi-hat, which the corpus shows
 *   plainly (SOP §7), and those map one to one onto the driver's BD..HH.
 * - **Melodic tracks share what is left**, six voices in percussive mode and
 *   nine otherwise, allocated per note. A track keeps its voice while its note
 *   sounds; when every voice is busy the one whose note ends soonest is cut
 *   short, because that is the note that had least left to lose.
 * - **Panning is dropped.** The chip is mono. So are the four-op instruments'
 *   second operator pair, and the OPL3 wave selects; see `sopPatch`.
 *
 * What comes out is the song as an OPL2 could have played it, which is not
 * the song. Anything wanting the real thing needs an OPL3 core.
 *
 * @param {import("./formats.js").SopSong} song
 * @returns {SeqEvent[]}
 */
export function sopSequence(song) {
  const percussive = song.percussive;
  const melodicVoices = percussive ? BD : 9;
  const patches = song.instruments.map(sopPatch);
  const nTracks = song.tracks.length;

  /** Percussive mode parks the five rhythm instruments on their own slots. */
  const rhythmVoiceOf = (t) => (percussive && t >= BD && t <= HH ? t : -1);

  // Merge every track with the control track, keeping file order inside each.
  // Array.prototype.sort is stable, so sorting on (tick, source) alone leaves
  // a track's own events in the order it stored them -- which matters, because
  // a SOP sets the patch, volume and pitch of a note in the tick before it.
  const merged = [];
  for (const ev of song.control) merged.push({ ev, track: -1, source: 0 });
  for (let t = 0; t < nTracks; t++) {
    for (const ev of song.tracks[t].events) merged.push({ ev, track: t, source: 1 });
  }
  merged.sort((a, b) => a.ev.tick - b.ev.tick || a.source - b.source);

  const out = [];
  let globalVolume = 127;
  const trackPatch = new Array(nTracks).fill(-1);
  const trackVolume = new Array(nTracks).fill(127);
  const trackBend = new Array(nTracks).fill(100);     // §4.2: 100 is centre
  const trackVoice = new Array(nTracks).fill(-1);
  const touched = new Array(nTracks).fill(false);
  const voiceTrack = new Array(melodicVoices).fill(-1);
  const voiceEnd = new Int32Array(melodicVoices);
  /** The note-off already emitted for each voice, so that a steal can pull it in. */
  const voiceOff = new Array(11).fill(null);
  // -2 is "nothing loaded", -1 is "the fallback below". A track that never
  // sends an instrument-select still has to make a sound: ST-BGM.SOP has 4878
  // notes and not one event 6, so it is relying on whatever the editor had
  // loaded. The first instrument that yields a patch is the least-invented
  // stand-in for that.
  const voicePatch = new Array(11).fill(-2);
  const fallback = patches.find((p) => p) ?? null;

  // §4.2: volume is 0..127 and so is the driver's, but the control track's
  // global volume scales all of it, and that is how SOP fades a whole song.
  const volumeOf = (t) => Math.round((trackVolume[t] * globalVolume) / 127);
  // §4.2: pitch is 0..200 about a centre of 100, which is one semitone either
  // way -- exactly the driver's 14-bit bend at a pitch range of 1.
  const bendOf = (t) => {
    const v = MID_PITCH + Math.round(((trackBend[t] - 100) * MID_PITCH) / 100);
    return v < 0 ? 0 : v > 0x3fff ? 0x3fff : v;
  };

  const emitVolume = (tick, voice, t) =>
    out.push({ tick, type: VOLUME, voice, volume: volumeOf(t), order: 2 });

  /** A voice for a melodic track's note: its own, a free one, or a stolen one. */
  const allocate = (t, tick) => {
    const own = trackVoice[t];
    if (own >= 0 && voiceTrack[own] === t) return own;
    for (let v = 0; v < melodicVoices; v++) {
      if (voiceTrack[v] < 0 || voiceEnd[v] <= tick) return v;
    }
    let best = 0;
    for (let v = 1; v < melodicVoices; v++) if (voiceEnd[v] < voiceEnd[best]) best = v;
    return best;
  };

  let lastTick = 0;
  for (const { ev, track } of merged) {
    lastTick = ev.tick;
    if (track < 0) {
      if (ev.code === 3) {                                   // §5: tempo, in bpm
        out.push({ tick: ev.tick, type: TEMPO, tempo: ev.value, order: 0 });
      } else if (ev.code === 8) {                            // §5: global volume
        globalVolume = ev.value;
        for (let t = 0; t < nTracks; t++) {
          if (!touched[t]) continue;
          const voice = rhythmVoiceOf(t);
          if (voice >= 0) emitVolume(ev.tick, voice, t);
          else if (trackVoice[t] >= 0 && voiceTrack[trackVoice[t]] === t) {
            emitVolume(ev.tick, trackVoice[t], t);
          }
        }
      }
      continue;
    }
    touched[track] = true;
    const held = rhythmVoiceOf(track) >= 0
      ? rhythmVoiceOf(track)
      : (trackVoice[track] >= 0 && voiceTrack[trackVoice[track]] === track
        ? trackVoice[track] : -1);

    switch (ev.code) {
      case 6:                                                // §4.2: instrument
        trackPatch[track] = ev.value;
        if (held >= 0 && voicePatch[held] !== ev.value && patches[ev.value]) {
          out.push({ tick: ev.tick, type: PATCH, voice: held, patch: patches[ev.value], order: 1 });
          voicePatch[held] = ev.value;
        }
        break;
      case 4:                                                // §4.2: volume
        trackVolume[track] = ev.value;
        if (held >= 0) emitVolume(ev.tick, held, track);
        break;
      case 5:                                                // §4.2: pitch
        trackBend[track] = ev.value;
        if (held >= 0) out.push({ tick: ev.tick, type: BEND, voice: held, bend: bendOf(track), order: 2 });
        break;
      case 2: {                                              // §4.2: note on
        // §4.2 gives a note its length up front, which is what makes a static
        // allocator possible at all: the sequencer knows when each voice frees.
        const length = Math.max(1, ev.length ?? 1);
        const endTick = ev.tick + length;
        let voice = rhythmVoiceOf(track);
        if (voice < 0) {
          voice = allocate(track, ev.tick);
          const previous = voiceTrack[voice];
          if (previous >= 0 && previous !== track) trackVoice[previous] = -1;
          voiceTrack[voice] = track;
          voiceEnd[voice] = endTick;
          trackVoice[track] = voice;
        }
        // Cutting the outgoing note-off back to now is the whole of the steal:
        // note-offs sort ahead of note-ons, so the voice is free in time. A
        // rhythm voice needs it just as much -- two hits on one drum inside a
        // note's length would otherwise have the first one's off cut the second.
        if (voiceOff[voice] && voiceOff[voice].tick > ev.tick) voiceOff[voice].tick = ev.tick;
        const chosen = trackPatch[track] >= 0 && patches[trackPatch[track]]
          ? trackPatch[track] : -1;
        const patch = chosen >= 0 ? patches[chosen] : fallback;
        if (patch && voicePatch[voice] !== chosen) {
          out.push({ tick: ev.tick, type: PATCH, voice, patch, order: 1 });
          voicePatch[voice] = chosen;
        }
        emitVolume(ev.tick, voice, track);
        out.push({ tick: ev.tick, type: BEND, voice, bend: bendOf(track), order: 2 });
        out.push({ tick: ev.tick, type: NOTE_ON, voice, note: ev.value, order: 4 });
        const off = { tick: endTick, type: NOTE_OFF, voice, order: 3 };
        out.push(off);
        voiceOff[voice] = off;
        break;
      }
      default:
        // §4.2: 7 is panning, which a mono chip has nowhere to put, and 1 is
        // the "special event" nobody has ever explained -- 7 of it in the
        // whole corpus. Both are dropped rather than guessed at.
        break;
    }
  }

  // Tempo, then patch, then volume and pitch, then note-offs, then note-ons --
  // so a note hears its own setup, and so a voice taken back from another track
  // is released before it is keyed again.
  out.sort((a, b) => a.tick - b.tick || a.order - b.order);
  // The end comes off the sorted array, not off the last event read: a note
  // started on the final tick still has its length to run, and ending the song
  // at the last *input* tick would cut it off.
  const last = out.length ? out[out.length - 1].tick : lastTick;
  out.push({ tick: last + 1, type: END, order: 9 });
  return out;
}
