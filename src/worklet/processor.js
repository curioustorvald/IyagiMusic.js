// AudioWorkletProcessor wrapper. The chip and the sequencer do not know this
// file exists; everything here is message plumbing and the render callback.

/* global sampleRate, currentTime, AudioWorkletProcessor, registerProcessor */

import { IyagiMusic } from "../player.js";

/** How often to post the playhead back to the page, in seconds. */
const REPORT_INTERVAL = 1 / 60;

class IyagiProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.music = null;
    this.playing = false;
    this.lastReport = 0;
    this.left = new Float32Array(128);
    this.right = new Float32Array(128);
    // One meter buffer for the life of the processor: postMessage copies it,
    // so it can be refilled every frame without allocating on the audio thread.
    this.meter = IyagiMusic.meterBuffer();
    this.patchEpoch = -1;
    this.port.onmessage = (e) => this.#command(e.data);
  }

  #command(msg) {
    switch (msg.type) {
      case "load":
        try {
          this.music = new IyagiMusic({
            song: msg.song,
            bank: msg.bank,
            fallbackBank: msg.fallbackBank,
            lyrics: msg.lyrics,
            sampleRate,
            chip: msg.chip,
            implayStereo: !!msg.implayStereo,
            tone: msg.tone,
          });
          // The page's slider is a fraction of the chip's headroom, not an
          // absolute scale -- an OPL3 song has twenty voices to fit into the
          // same output as an OPL2 song's nine.
          if (msg.volume !== undefined) this.music.volume = msg.volume;
          this.music.loop = !!msg.loop;
          // A listener's settings outlive the song: the page sends them with
          // every load rather than reapplying them after it.
          if (msg.mono !== undefined) this.music.mono = !!msg.mono;
          if (msg.speed !== undefined) this.music.speed = msg.speed;
          if (msg.transpose !== undefined) this.music.transpose = msg.transpose;
          this.playing = false;
          this.patchEpoch = -1;
          this.port.postMessage({
            type: "loaded",
            kind: this.music.kind,
            title: this.music.title,
            missing: this.music.missing,
            lyrics: this.music.lyrics,
            tickBeat: this.music.song.tickBeat,
            chip: this.music.chipKind,
            implayStereo: this.music.mirror,
            canStereo: this.music.canStereo,
            duration: this.music.duration,
            tempo: this.music.tempo,
            instrumentCount: this.music.instrumentCount,
            percussive: !!this.music.song.percussive,
          });
          // One frame of chip status right away, so a display can lay itself
          // out for the right number of voices before anything is played.
          this.#report(true);
        } catch (err) {
          this.music = null;
          this.port.postMessage({ type: "error", message: String(err && err.message || err) });
        }
        break;
      case "play": this.playing = !!this.music; break;
      case "meters": this.#report(true); break;
      case "pause": this.playing = false; break;
      case "stop":
        this.playing = false;
        if (this.music) this.music.reset();
        this.#report(true);
        break;
      case "loop": if (this.music) this.music.loop = !!msg.value; break;
      case "volume": if (this.music) this.music.volume = msg.value; break;
      case "mono": if (this.music) this.music.mono = !!msg.value; break;
      case "tone": if (this.music) this.music.tone = msg.value; break;
      case "speed": if (this.music) this.music.speed = msg.value; break;
      case "transpose": if (this.music) this.music.transpose = msg.value; break;
      case "seek":
        if (this.music) { this.music.seek(msg.seconds); this.#report(true); }
        break;
      default: break;
    }
  }

  #report(force) {
    if (!this.music) return;
    if (!force && currentTime - this.lastReport < REPORT_INTERVAL) return;
    this.lastReport = currentTime;
    const msg = {
      type: "position",
      seconds: this.music.seconds,
      position: this.music.position,
      tempo: this.music.tempo,
      tick: this.music.tick,
      // What lyrics are held against: not `tick`, which is the next event's
      // and in the song's own unit (FILE_FORMATS §4.4).
      lyricTick: this.music.lyricTick,
      ended: this.music.ended,
      meter: this.music.readMeters(this.meter),
      voices: this.music.voiceCount,
      chipFlags: this.music.chipFlags,
    };
    // Patch names change a handful of times in a whole song; send them only
    // when they have.
    if (this.music.patchEpoch !== this.patchEpoch) {
      this.patchEpoch = this.music.patchEpoch;
      msg.patchNames = this.music.patchNames.slice();
    }
    this.port.postMessage(msg);
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    if (!this.playing || !this.music) {
      for (const ch of out) ch.fill(0);
      return true;
    }
    if (this.left.length !== n) {
      this.left = new Float32Array(n);
      this.right = new Float32Array(n);
    }
    // Always the stereo call: on a YM3812 it is the mono stream twice, and on
    // a YMF262 it is the song's own panning, which is the only place in the
    // library where the two chips differ audibly rather than in count.
    const running = this.music.renderStereo(this.left, this.right, 0, n);
    out[0].set(this.left);
    for (let c = 1; c < out.length; c++) out[c].set(this.right);
    if (!running) { this.playing = false; this.#report(true); this.port.postMessage({ type: "ended" }); }
    else this.#report(false);
    return true;
  }
}

registerProcessor("iyagi-processor", IyagiProcessor);
