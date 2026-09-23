// What a listener can do to a song while it plays -- IMPLAY's controls, as
// ENGINE_SPEC §11.1 and §13 describe them -- and the two sound options the web
// player adds.
//
// The first test is the load-bearing one, in the same way as the first test of
// opl3.test.js: IMPLAY's stereo, switched to mono, must be the YM3812's mono
// sample for sample. That is what lets a listener flip between the two without
// reloading, and it is only honest if nothing else about the song changes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { OPL3 } from "../src/opl/chip.js";
import { AdlibDriver, IMPLAY_PAN, implaySplit } from "../src/driver.js";
import { IyagiMusic } from "../src/player.js";
import { Sequencer, NOTE_ON, NOTE_OFF, PATCH, TEMPO, END } from "../src/sequencer.js";
import { parseBnk } from "../src/formats.js";
import { NATIVE_RATE, METER_STRIDE, M_PEAK } from "../src/opl/constants.js";

const CORPUS = "/home/torvald/Documents/tsvm/reference_materials/Iyagi Music Sound";
const MEGA = path.join(CORPUS, "IMS_FILE_MEGA_CORPUS");
const have = fs.existsSync(MEGA);
const read = (fn) => new Uint8Array(fs.readFileSync(path.join(CORPUS, fn)));

const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

/** Render `seconds` of both channels. */
function stereo(music, seconds) {
  const n = Math.round(seconds * music.sampleRate);
  const left = new Float32Array(n), right = new Float32Array(n);
  music.renderStereo(left, right);
  return { left, right };
}

const song = () => ({ song: read("ZZ-BLCAT.IMS"), bank: read("STANDARD.BNK") });

test("IMPLAY's stereo in mono is the YM3812, sample for sample", { skip: !have }, () => {
  const plain = new IyagiMusic({ ...song() });
  const mirrored = new IyagiMusic({ ...song(), implayStereo: true });
  mirrored.mono = true;
  assert.equal(mirrored.chipKind, "opl3");
  const a = stereo(plain, 4), b = stereo(mirrored, 4);
  assert.ok(rms(a.left) > 0.01, "the song is audible");
  for (let i = 0; i < a.left.length; i++) {
    if (a.left[i] !== b.left[i] || a.left[i] !== b.right[i]) {
      assert.fail(`sample ${i}: OPL2 ${a.left[i]}, mirrored ${b.left[i]} / ${b.right[i]}`);
    }
  }
});

test("IMPLAY's stereo pans by the fixed table, and the drums stay centred", { skip: !have }, () => {
  const music = new IyagiMusic({ ...song(), implayStereo: true });
  const { left, right } = stereo(music, 4);
  assert.ok(rms(left) > 0.01 && rms(right) > 0.01);
  let differ = 0;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) differ++;
  assert.ok(differ > left.length / 2, "the two sides are different mixes");

  // Mono can be switched on and off mid-song, and it takes at once.
  music.mono = true;
  const after = stereo(music, 0.5);
  assert.deepEqual(after.left, after.right);
  music.mono = false;
  const back = stereo(music, 0.5);
  assert.notDeepEqual(back.left, back.right);
});

test("the pan split follows IMPLAY's arithmetic", () => {
  assert.deepEqual(implaySplit(127, 0x40), [127, 127]);
  // Channel 3, 0x12: the right side keeps 18/64 of the volume.
  assert.deepEqual(implaySplit(127, IMPLAY_PAN[3]), [127 - ((0x2e * 127) >> 6), 127]);
  // Channel 10, 0x72: the left side loses 50/64.
  assert.deepEqual(implaySplit(64, IMPLAY_PAN[10]), [64, 64 - ((0x32 * 64) >> 6)]);
  assert.equal(IMPLAY_PAN.length, 11);
});

test("the mirror writes each melodic register twice and each drum once", () => {
  const writes = [];
  const chip = { write: (reg, value) => writes.push([reg, value]), opl3: true };
  const driver = new AdlibDriver(chip, { mirror: true });
  driver.setMode(true);
  writes.length = 0;
  const bank = parseBnk(read("STANDARD.BNK"));
  const patch = bank.patches.find((p) => p);
  driver.setVoiceTimbre(3, patch);
  driver.setVoiceVolume(3, 127);
  driver.noteOn(3, 60);
  const regs = new Set(writes.map(([r]) => r));
  // Channel 3's operators are at offsets 0x08 and 0x0B; its key-on is 0xB3.
  for (const reg of [0x28, 0x2b, 0x48, 0x4b, 0x68, 0x6b, 0xa3, 0xb3, 0xc3]) {
    assert.ok(regs.has(reg) && regs.has(reg | 0x100), `0x${reg.toString(16)} on both banks`);
  }
  const last = (reg) => writes.filter(([r]) => r === reg).at(-1)[1];
  assert.equal(last(0xc3) & 0x30, 0x20, "bank 0 plays on the right");
  assert.equal(last(0x1c3) & 0x30, 0x10, "bank 1 plays on the left");
  // The carrier is louder on the left, where channel 3 leans.
  assert.ok((last(0x14b) & 63) < (last(0x4b) & 63));

  writes.length = 0;
  driver.setVoiceTimbre(6, patch);                        // the bass drum
  driver.noteOn(6, 48);
  assert.ok(writes.length > 0);
  assert.ok(writes.every(([r]) => r < 0x100), "the drums live on bank 0 alone");
});

test("the mirror folds back to one meter row per voice", { skip: !have }, () => {
  const music = new IyagiMusic({ ...song(), implayStereo: true });
  assert.equal(music.voiceCount, 11);
  stereo(music, 2);
  const rows = music.readMeters(IyagiMusic.meterBuffer());
  let lit = 0;
  for (let v = 0; v < 11; v++) if (rows[v * METER_STRIDE + M_PEAK] > 0) lit++;
  assert.ok(lit >= 4, `${lit} voices show a level`);
  for (let v = 11; v < 20; v++) assert.equal(rows[v * METER_STRIDE + M_PEAK], 0);
});

/** A two-voice song on a stub chip, for watching what the driver is told. */
function tiny(events, percussive = true) {
  const chip = {
    write() {}, opl3: false,
    generate(out, offset, count) { out.fill(0, offset, offset + count); },
  };
  return new Sequencer({ chip, events, tickBeat: 4, tempo: 60, percussive });
}

test("the key shift moves the melody and leaves the drums alone", () => {
  const events = [
    { tick: 0, type: NOTE_ON, voice: 0, note: 60 },
    { tick: 0, type: NOTE_ON, voice: 6, note: 60 },      // bass drum
    { tick: 0, type: NOTE_ON, voice: 8, note: 60 },      // tom
    { tick: 8, type: END },
  ];
  const seq = tiny(events);
  seq.transpose = -2;
  seq.render(new Float32Array(16), 0, 16);
  // Chip note = MIDI - 12 (ENGINE_SPEC §5.2).
  assert.equal(seq.driver.voiceNote[0], 46);
  assert.equal(seq.driver.voiceNote[6], 48);
  assert.equal(seq.driver.voiceNote[8], 48);
});

test("speed changes how fast the song goes and not where it ends", () => {
  const events = [
    { tick: 0, type: NOTE_ON, voice: 0, note: 60 },
    { tick: 4, type: TEMPO, tempo: 120 },
    { tick: 8, type: NOTE_OFF, voice: 0 },
    { tick: 12, type: END },
  ];
  // 60 bpm, four ticks a beat: one second to tick 4, then half a second a beat.
  const timeline = tiny(events).timeline();
  assert.equal(timeline.endTick, 12);
  assert.equal(timeline.duration, 2);
  assert.equal(timeline.secondsAt(8), 1.5);
  assert.equal(timeline.tickAt(1.5), 8);

  const length = (speed) => {
    const seq = tiny(events);
    seq.setSpeed(speed);
    const out = new Float32Array(NATIVE_RATE * 5);
    const n = seq.render(out, 0, out.length);
    return { n, song: seq.songSamples };
  };
  const normal = length(1), fast = length(2), slow = length(0.5);
  assert.ok(Math.abs(normal.n - 2 * NATIVE_RATE) <= 2);
  assert.ok(Math.abs(fast.n - NATIVE_RATE) <= 2);
  assert.ok(Math.abs(slow.n - 4 * NATIVE_RATE) <= 2);
  // Song time runs to the same end at every speed.
  for (const r of [normal, fast, slow]) assert.ok(Math.abs(r.song - 2 * NATIVE_RATE) <= 2);
});

test("a seek lands where playing that far would have", () => {
  const events = [
    { tick: 0, type: PATCH, voice: 0, patch: 0 },
    { tick: 0, type: NOTE_ON, voice: 0, note: 60, volume: 100 },
    { tick: 4, type: TEMPO, tempo: 120 },
    { tick: 6, type: NOTE_ON, voice: 1, note: 64, volume: 50 },
    { tick: 20, type: END },
  ];
  const played = tiny(events);
  // Tick 6 falls at 1.25 s; stop a little after it, before tick 7 at 1.375 s.
  played.render(new Float32Array(NATIVE_RATE * 2), 0, Math.round(NATIVE_RATE * 1.3));
  const sought = tiny(events);
  sought.seek(7);
  assert.equal(sought.tempo, played.tempo);
  assert.equal(sought.tick, 7);
  assert.deepEqual(sought.driver.voiceVolume, played.driver.voiceVolume);
  assert.deepEqual(sought.driver.voiceNote, played.driver.voiceNote);
  assert.ok(sought.driver.voiceKeyOn[0] && sought.driver.voiceKeyOn[1], "held notes are held");
  assert.equal(sought.songSamples, Math.round(1.375 * NATIVE_RATE));
});

test("a player seek lands on the second it was asked for", { skip: !have }, () => {
  const music = new IyagiMusic({ ...song(), implayStereo: true });
  assert.ok(music.duration > 30);
  music.seek(20);
  assert.ok(Math.abs(music.position - 20) < 0.5, `landed at ${music.position}`);
  const { left } = stereo(music, 1);
  assert.ok(rms(left) > 0.01, "and it plays from there");
  music.seek(1e9);
  assert.ok(music.position <= music.duration + 0.01);
});

test("the standard tone is softer at the top and the raw tone is the chip", { skip: !have }, () => {
  const raw = new IyagiMusic({ ...song() });
  const standard = new IyagiMusic({ ...song(), tone: "standard" });
  assert.equal(raw.chip.feedbackScale, 1);
  assert.equal(standard.chip.feedbackScale, 0.875);
  const a = stereo(raw, 3).left, b = stereo(standard, 3).left;
  // Energy by band, from a plain DFT of one block. The top octave-and-a-bit
  // has to lose most of its energy and the body of the sound almost none.
  const band = (x, lo, hi) => {
    const N = 2048, at = x.length - N, rate = raw.sampleRate;
    let sum = 0;
    for (let k = Math.ceil(lo * N / rate); k <= Math.floor(hi * N / rate); k++) {
      let re = 0, im = 0;
      for (let n = 0; n < N; n++) {
        const w = 2 * Math.PI * k * n / N;
        re += x[at + n] * Math.cos(w); im -= x[at + n] * Math.sin(w);
      }
      sum += re * re + im * im;
    }
    return sum;
  };
  const top = band(b, 16000, 23000) / band(a, 16000, 23000);
  const body = band(b, 100, 4000) / band(a, 100, 4000);
  assert.ok(top < 0.5, `16-23 kHz keeps ${top} of its energy`);
  assert.ok(body > 0.8, `0.1-4 kHz keeps ${body} of its energy`);
  assert.throws(() => { raw.tone = "warm"; });
  raw.tone = "standard";
  assert.equal(raw.chip.feedbackScale, 0.875);
});

test("an IMPLAY OPL3 has no effect on a .sop", { skip: !have }, () => {
  const sop = fs.readdirSync(MEGA).find((f) => f.toUpperCase().endsWith(".SOP"));
  const music = new IyagiMusic({
    song: new Uint8Array(fs.readFileSync(path.join(MEGA, sop))), implayStereo: true,
  });
  assert.equal(music.mirror, false);
  assert.equal(music.voiceCount >= 18, true);
  assert.ok(music.instrumentCount > 0);
  assert.ok(music.chip instanceof OPL3);
});
