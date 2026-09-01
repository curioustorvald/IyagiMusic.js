// Turning a parsed song into driver calls, on a sample-accurate clock.
//
// Both formats reduce to the same thing: a stream of events carrying absolute
// tick positions, plus a tempo that events may change. The sequencer owns the
// clock (docs/ENGINE_SPEC.en.md §9) and the driver owns the chip.

import { AdlibDriver, BD, HH } from "./driver.js";
import { imsEvents } from "./formats.js";
import { NATIVE_RATE } from "./opl/constants.js";

/** Event kinds a sequencer understands. */
export const NOTE_ON = 0, NOTE_OFF = 1, VOLUME = 2, PATCH = 3, BEND = 4,
  TEMPO = 5, END = 6;

export class Sequencer {
  /**
   * @param {object} opts
   * @param {{write(reg:number,value:number):void}} opts.chip
   * @param {Iterable<object>} opts.events  absolute-tick events, in order
   * @param {number} opts.tickBeat          ticks per beat
   * @param {number} opts.tempo             beats per minute
   * @param {boolean} opts.percussive
   * @param {number} [opts.pitchRange]
   * @param {Array} [opts.patches]          resolved bank patches, by index
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
    this.tempo = this.baseTempo;
    this.iterator = this.makeEvents[Symbol.iterator]();
    this.pending = this.iterator.next();
    this.tick = 0;
    this.sampleCursor = 0;      // fractional samples owed before the next event
    this.samplesRendered = 0;
    this.ended = false;
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
        if (patch) d.setVoiceTimbre(ev.voice, patch);
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

/** Flatten an IMS song into sequencer events. §1.4 of the formats doc. */
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
