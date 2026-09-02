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
    this.mono = new Float32Array(128);
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
            gain: msg.gain,
          });
          this.music.loop = !!msg.loop;
          this.playing = false;
          this.patchEpoch = -1;
          this.port.postMessage({
            type: "loaded",
            kind: this.music.kind,
            title: this.music.title,
            missing: this.music.missing,
            lyrics: this.music.lyrics,
            tickBeat: this.music.song.tickBeat,
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
      case "gain": if (this.music) this.music.gain = msg.value; break;
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
      tick: this.music.tick,
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
    if (this.mono.length !== n) this.mono = new Float32Array(n);
    const running = this.music.render(this.mono, 0, n);
    for (const ch of out) ch.set(this.mono);
    if (!running) { this.playing = false; this.#report(true); this.port.postMessage({ type: "ended" }); }
    else this.#report(false);
    return true;
  }
}

registerProcessor("iyagi-processor", IyagiProcessor);
