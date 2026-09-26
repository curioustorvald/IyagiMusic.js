// SOP checks. The first half builds files in code, so it runs on a clean
// checkout; the second half pins what the corpus measures, because every
// *(measured)* claim in docs/SOP_FORMAT.en.md is only as good as something
// that fails when it stops being true.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  IyagiMusic, parseSop, sopPatch, identify, METER_STRIDE, M_KEY_ON, M_NOTE, M_VOLUME, M_PEAK,
} from "../src/player.js";
import {
  sopSequence, sopTempo, sopGameTempo, sopSampleGain, sopSamplePan, sopSampleCents,
  NOTE_ON, NOTE_OFF, PATCH, PAN, VOLUME, TEMPO,
} from "../src/sequencer.js";
import { PAN_NONE, PAN_CENTRE, PAN_LEFT, PAN_RIGHT } from "../src/opl/constants.js";
import { FormatError } from "../src/formats.js";
import { AdlibDriver } from "../src/driver.js";
import { PcmMixer } from "../src/pcm.js";
import { NATIVE_RATE } from "../src/opl/constants.js";

const CORPUS = "/home/torvald/Documents/tsvm/reference_materials/Iyagi Music Sound";
const MEGA = path.join(CORPUS, "IMS_FILE_MEGA_CORPUS");
const have = fs.existsSync(MEGA);
const sopFiles = () =>
  fs.readdirSync(MEGA).filter((f) => f.toUpperCase().endsWith(".SOP")).sort();
const read = (fn) => new Uint8Array(fs.readFileSync(path.join(MEGA, fn)));
// §10: the four version-0.2 files, which are not part of the corpus.
const V02 = "/home/torvald/Documents/tsvm/reference_materials/sop/extracted";
const V02_FILES = ["ending.sop", "ending03.sop", "mute.sop", "op.sop"];
const haveV02 = V02_FILES.every((f) => fs.existsSync(path.join(V02, f)));

/**
 * How many bytes the parse accounts for: header, mode table, every instrument
 * record, and every track at four bytes an event, six for a note-on. parseSop
 * itself does not insist on reaching the last byte, so a test that means "the
 * walk ends where the file does" has to compare this with the file's length.
 */
const sopByteLength = (s) =>
  76 + s.tracks.length
  + s.instruments.reduce((n, i) => n + 28 + i.data.length, 0)
  + [...s.tracks.map((t) => t.events), s.control]
    .reduce((n, evs) => n + 6 + evs.reduce((m, e) => m + (e.code === 2 ? 6 : 4), 0), 0);

/* ------------------------------------------------------------- synthetic */

const N_TRACKS = 20;

/** Build a SOP by hand, so the reader is checked against the spec, not a file. */
function buildSop({
  title = "TEST", fileName = "TEST.SOP", percussive = 1, tickBeat = 8,
  beatMeasure = 4, basicTempo = 120, chanMode = new Array(N_TRACKS).fill(2),
  instruments = [], tracks = new Array(chanMode.length).fill(null).map(() => []),
  control = [], version = 1,
} = {}) {
  const out = [];
  const put = (...b) => out.push(...b);
  const str = (s, n) => {
    const b = new Array(n).fill(0);
    for (let i = 0; i < Math.min(s.length, n); i++) b[i] = s.charCodeAt(i);
    return b;
  };
  const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];

  put(..."sopepos".split("").map((c) => c.charCodeAt(0)), 0, version, 0);
  put(...str(fileName, 13), ...str(title, 31));
  put(percussive, 0, tickBeat, 0, beatMeasure, basicTempo);
  put(...str("", 13), chanMode.length, instruments.length, 0);
  put(...chanMode);
  for (const i of instruments) {
    put(i.type, ...str(i.shortName ?? "", 8), ...str(i.longName ?? "", 19), ...(i.data ?? []));
  }
  const body = (events, isControl) => {
    const bytes = [];
    for (const e of events) {
      bytes.push(...u16(e.delta), e.code, e.value);
      if (!isControl && e.code === 2) bytes.push(...u16(e.length));
    }
    return [...u16(events.length), ...u32(bytes.length), ...bytes];
  };
  for (const t of tracks) put(...body(t, false));
  put(...body(control, true));
  return new Uint8Array(out);
}

const MELODY = {
  type: 1, shortName: "PIANO", longName: "A Piano",
  // A real corpus instrument (REAL.2IM), so the unpacking has something with
  // every field populated to be checked against.
  data: [0x30, 0x10, 0xf3, 0x23, 0x07, 0x06, 0x11, 0x00, 0xf2, 0x33, 0x04],
};

test("a hand-built SOP reads back field for field", () => {
  const tracks = new Array(N_TRACKS).fill(null).map(() => []);
  tracks[0] = [
    { delta: 0, code: 6, value: 0 },
    { delta: 0, code: 4, value: 100 },
    { delta: 0, code: 5, value: 150 },
    { delta: 4, code: 2, value: 60, length: 8 },
  ];
  const bytes = buildSop({
    title: "A Title", fileName: "SONG.SOP", percussive: 0, tickBeat: 12,
    instruments: [MELODY, { type: 12, longName: " a credit line" }],
    tracks,
    control: [{ delta: 0, code: 8, value: 127 }, { delta: 16, code: 3, value: 140 }],
  });

  assert.equal(identify(bytes), "sop");
  const song = parseSop(bytes);
  assert.deepEqual(song.version, [0, 1]);
  assert.equal(song.title, "A Title");
  assert.equal(song.fileName, "SONG.SOP");
  assert.equal(song.percussive, false);
  assert.equal(song.tickBeat, 12);
  assert.equal(song.beatMeasure, 4);
  assert.equal(song.basicTempo, 120);
  assert.equal(song.tracks.length, N_TRACKS);
  assert.equal(song.instruments.length, 2);
  assert.equal(song.instruments[0].shortName, "PIANO");
  assert.deepEqual(song.comments, [" a credit line"]);

  // Deltas accumulate into absolute ticks; a note-on carries its own length.
  assert.deepEqual(song.tracks[0].events.map((e) => [e.tick, e.code, e.value]),
    [[0, 6, 0], [0, 4, 100], [0, 5, 150], [4, 2, 60]]);
  assert.equal(song.tracks[0].events[3].length, 8);
  assert.deepEqual(song.control.map((e) => [e.tick, e.code, e.value]), [[0, 8, 127], [16, 3, 140]]);
});

test("instType 2 is an eleven-byte record, as NOTE.EXE writes it", () => {
  // SOP §3.1: the editor labels type 2 "1OP" and loads it with the same
  // routine as type 1. No corpus file carries one, so it is built here.
  const oneOp = { ...MELODY, type: 2, shortName: "ONEOP" };
  const song = parseSop(buildSop({ instruments: [oneOp, MELODY] }));
  assert.deepEqual(song.instruments.map((i) => i.type), [2, 1]);
  assert.equal(song.instruments[1].shortName, "PIANO");
  const a = sopPatch(song.instruments[0]);
  const b = sopPatch(song.instruments[1]);
  assert.deepEqual({ ...a, name: "" }, { ...b, name: "" });
});

test("the reader refuses what it cannot account for", () => {
  assert.throws(() => parseSop(new Uint8Array(76)), FormatError);
  const bad = buildSop({ instruments: [{ type: 5, data: [] }] });
  assert.throws(() => parseSop(bad), /unknown instType 5/);
  // An event code outside the documented set means the walk has lost alignment,
  // so it is an error rather than something to skip over.
  const tracks = new Array(N_TRACKS).fill(null).map(() => []);
  tracks[0] = [{ delta: 0, code: 9, value: 0 }];
  assert.throws(() => parseSop(buildSop({ tracks })), /unknown event 9/);
});

/** A version-0.2 PCM record, SOP §10.3, holding `samples` at `rate`. */
function pcmInstrument(name, samples, rate, at) {
  const head = [
    ...[0, 8, 16, 24].map((s) => ((at + 47) >>> s) & 0xff),     // where the samples start
    samples.length & 0xff, samples.length >> 8,
    Math.floor(3579545 / rate) & 0xff, Math.floor(3579545 / rate) >> 8,
    rate & 0xff, rate >> 8,
    64, 0, 0, 0, 0, 4, 0, 0x53, 0x45,                              // as all six known records
  ];
  return { type: 11, shortName: name, longName: name, data: [...head, ...samples.map((v) => v & 0xff)] };
}

test("a version-0.2 SOP reads its twenty-four tracks and its PCM instruments", () => {
  // §10: nTracks is believed, so the mode table and the tracks run to 24, and
  // a type-11 record carries a nineteen-byte head and its samples inline.
  const chanMode = [...new Array(20).fill(2), 3, 3, 3, 3];
  const tracks = chanMode.map(() => []);
  tracks[20] = [{ delta: 0, code: 6, value: 1 }, { delta: 4, code: 2, value: 24, length: 8 }];
  const at = 76 + 24 + 28 + MELODY.data.length;
  const samples = [0, 3, -3, 127, -128, 5];
  const bytes = buildSop({
    version: 2, chanMode, tracks,
    instruments: [MELODY, pcmInstrument("BOOM", samples, 11025, at), MELODY],
  });
  const song = parseSop(bytes);
  assert.deepEqual(song.version, [0, 2]);
  assert.equal(song.tracks.length, 24);
  assert.deepEqual(song.tracks.slice(19).map((t) => t.mode), [2, 3, 3, 3, 3]);
  const pcm = song.instruments[1];
  assert.equal(pcm.type, 11);
  assert.equal(pcm.shortName, "BOOM");
  assert.equal(pcm.pcm.rate, 11025);
  assert.equal(pcm.pcm.period, 324);
  assert.deepEqual([...pcm.pcm.samples], samples, "the samples are signed");
  assert.equal(sopPatch(pcm), null, "a sample is no patch");
  // The record after the samples is found, which is the length being right.
  assert.equal(song.instruments[2].shortName, "PIANO");
  assert.deepEqual(song.tracks[20].events.map((e) => [e.tick, e.code, e.value]), [[0, 6, 1], [4, 2, 24]]);
  assert.equal(sopByteLength(song), bytes.length);

  // §3.1: Note has no record for type 11, so a version-0.1 file with one is
  // still unreadable.
  const old = buildSop({ instruments: [pcmInstrument("BOOM", samples, 11025, 96)] });
  assert.throws(() => parseSop(old), /unknown instType 11/);
});

test("a version-0.2 WAV track plays on a sample voice, not the FM chip, and 64 pans to the centre", () => {
  // §10.2: mode 3 plays samples, so none of its notes may reach an OPL voice;
  // they go to sample voice 0, the first WAV track's.
  // §10.4: 64 is the middle of version 0.2's pan scale. Read as version 0.1
  // it would clear both output bits and silence the channel.
  const chanMode = [...new Array(20).fill(2), 3, 3, 3, 3];
  const tracks = chanMode.map(() => []);
  const at = 76 + 24 + 28 + MELODY.data.length;
  tracks[0] = [{ delta: 0, code: 7, value: 64 }, { delta: 0, code: 6, value: 0 },
    { delta: 0, code: 2, value: 60, length: 4 }];
  tracks[20] = [{ delta: 0, code: 7, value: 64 }, { delta: 0, code: 6, value: 1 },
    { delta: 0, code: 2, value: 24, length: 4 }];
  const song = parseSop(buildSop({
    version: 2, percussive: 0, chanMode, tracks,
    instruments: [MELODY, pcmInstrument("BOOM", [0, 1, 2], 11025, at)],
  }));
  const seq = sopSequence(song, { melodicVoices: 18, rhythmBase: 18, fourOpPairs: [] });
  const on = seq.filter((e) => e.type === NOTE_ON);
  assert.deepEqual(on.filter((e) => !e.pcm).map((e) => e.note), [60]);
  assert.deepEqual(on.filter((e) => e.pcm).map((e) => [e.voice, e.note]), [[0, 24]]);
  assert.deepEqual(seq.filter((e) => e.type === PAN && !e.pcm).map((e) => e.pan), [PAN_CENTRE]);
  assert.deepEqual(seq.filter((e) => e.type === PAN && e.pcm).map((e) => [e.left, e.right]), [[1, 1]]);
  assert.deepEqual(seq.filter((e) => e.type === PATCH && e.pcm).map((e) => e.sample?.rate ?? null),
    [11025]);
});

test("version-0.2 FM pans are the game's switches: below 64 is 0's side, above is 2's", () => {
  // §10.4 (KMAN.EXE): the game adds 63 to a version-0.1 pan, so 0, 1, 2 are
  // 63, 64, 65 to it, and anything below 64 is as hard to one side as 0 is.
  const chanMode = [...new Array(20).fill(2), 3, 3, 3, 3];
  const tracks = chanMode.map(() => []);
  [54, 64, 74].forEach((value, t) => {
    tracks[t] = [{ delta: 0, code: 7, value }, { delta: 0, code: 6, value: 0 },
      { delta: 0, code: 2, value: 60, length: 4 }];
  });
  const seq = sopSequence(parseSop(buildSop({ version: 2, percussive: 0, chanMode, tracks,
    instruments: [MELODY] })), { melodicVoices: 18, rhythmBase: 18, fourOpPairs: [] });
  const pans = seq.filter((e) => e.type === PAN).map((e) => e.pan);
  assert.deepEqual(pans, [PAN_RIGHT, PAN_CENTRE, PAN_LEFT], "54, 64, 74 in track order");
});

test("a WAV track's volume, pan and pitch follow 개미맨's mixer", () => {
  // §10.6 (KMAN.EXE): volume (v >> 1) + 1 of 64, linear; pan 128 − v, the
  // near side whole and the far side a linear share, below 64 louder on the
  // left; pitch >> 3 as twelfths of a semitone, a semitone at most.
  assert.equal(sopSampleGain(127), 1);
  assert.equal(sopSampleGain(96), 49 / 64);
  assert.equal(sopSampleGain(0), 1 / 64, "0 is not silence");
  assert.deepEqual(sopSamplePan(64), { left: 1, right: 1 });
  assert.deepEqual(sopSamplePan(0), { left: 1, right: 0 });
  assert.deepEqual(sopSamplePan(127), { left: 1 / 64, right: 1 });
  assert.deepEqual(sopSamplePan(32), { left: 1, right: 0.5 });
  assert.equal(sopSampleCents(100), 0);
  assert.equal(sopSampleCents(0), -100);
  assert.equal(sopSampleCents(200), 100);
  assert.equal(sopSampleCents(104), 100 / 12, "one row of the period table");
  assert.equal(sopSampleCents(103), 0, "quantised down");
});

test("an overlapping sample note slurs; a touching one strikes again", () => {
  // §10.6 (KMAN.EXE): the game's note-on starts a sample only if the voice's
  // last note has ended, and a note-off due on the same tick comes first.
  const chanMode = [...new Array(20).fill(2), 3, 3, 3, 3];
  const tracks = chanMode.map(() => []);
  tracks[20] = [{ delta: 0, code: 6, value: 0 },
    { delta: 0, code: 2, value: 24, length: 8 },     // 0..8
    { delta: 4, code: 2, value: 26, length: 8 },     // 4..12, over the first
    { delta: 8, code: 2, value: 28, length: 8 }];    // 12..20, touching
  const seq = sopSequence(parseSop(buildSop({ version: 2, percussive: 0, chanMode, tracks,
    instruments: [pcmInstrument("S", [0, 1, 2, 3], 11025, 76 + 24)] })));
  assert.deepEqual(seq.filter((e) => e.pcm && e.type === NOTE_ON).map((e) => [e.tick, e.legato]),
    [[0, false], [4, true], [12, false]]);
  // §10.6: selecting a slot that holds no sample leaves the voice with none.
  const fm = sopSequence(parseSop(buildSop({ version: 2, percussive: 0, chanMode,
    tracks: chanMode.map((_, t) => t === 20 ? [{ delta: 0, code: 6, value: 1 },
      { delta: 0, code: 6, value: 0 }, { delta: 0, code: 2, value: 24, length: 4 }] : []),
    instruments: [MELODY, pcmInstrument("S", [0, 1, 2, 3], 11025, 76 + 24 + 28 + 11)] })));
  assert.deepEqual(fm.filter((e) => e.pcm && e.type === PATCH).map((e) => e.sample?.rate ?? null),
    [11025, null]);
  // The first note's off is gone; the slurred note's end stops it.
  assert.deepEqual(seq.filter((e) => e.pcm && e.type === NOTE_OFF).map((e) => e.tick), [12, 20]);
});

test("a version-0.2 song keeps the game's time, not Note's", () => {
  // §10.8 (KMAN.EXE): PIT counts to the tick, 60 × 1193182 ÷ tickBeat ÷ bpm
  // in integers, never fewer than one of the game's ~35 Hz timer periods.
  const counts = Math.floor(Math.floor(60 * 1193182 / 8) / 120);
  assert.equal(sopGameTempo(120, 8), 60 * 1193182 / (counts * 8));
  assert.ok(Math.abs(sopGameTempo(120, 8) - 120) < 0.01, "as written, near enough");
  assert.ok(Math.abs(sopTempo(120, 8) - 120.04) < 0.01, "where Note's is 120.04");
  const floor = 60 * 1193182 / (0x851e * 16);
  assert.equal(sopGameTempo(255, 16), floor, "held to one timer period a tick");
  assert.equal(sopGameTempo(0, 8), sopGameTempo(120, 8), "0 means 120");
});

test("the sample mixer plays a sample at the rate it is told, and stops at its end", () => {
  // A ramp, so where the mixer is in the sample can be read off its output.
  const ramp = { samples: Int8Array.from({ length: 101 }, (_, i) => i), rate: NATIVE_RATE };
  const m = new PcmMixer(2);
  m.setSample(0, ramp);
  m.trigger(0, NATIVE_RATE / 2);                  // half speed: two outputs a sample
  const out = new Float32Array(300);
  m.mix(out, null, 0, out.length);
  const unit = 0.5 / 128;                          // one step of a full-scale sample
  assert.ok(Math.abs(out[20] - 10 * unit) < 1e-7, "sample 10 at output 20");
  assert.ok(Math.abs(out[21] - 10.5 * unit) < 1e-7, "interpolated between them");
  assert.equal(out[250], 0, "silent past the end");
  assert.equal(m.active, false);

  // Gain and pan are linear, per side.
  const L = new Float32Array(8), R = new Float32Array(8);
  m.setSample(1, ramp); m.setGain(1, 0.5); m.setPan(1, 1, 0.25);
  m.trigger(1, NATIVE_RATE);
  m.mix(L, R, 0, 8);
  assert.ok(Math.abs(L[4] - 4 * unit * 0.5) < 1e-7);
  assert.ok(Math.abs(R[4] - 4 * unit * 0.5 * 0.25) < 1e-7);
});

test("a sample voice's rate comes from the reference note, and its note-off obeys sampleCut", () => {
  const chanMode = [...new Array(20).fill(2), 3, 3, 3, 3];
  const tracks = chanMode.map(() => []);
  const at = 76 + 24;
  // Two notes a semitone apart, 8 ticks each, 16 ticks apart; a long sample.
  tracks[20] = [{ delta: 0, code: 6, value: 0 }, { delta: 0, code: 4, value: 127 },
    { delta: 0, code: 2, value: 24, length: 8 }, { delta: 16, code: 2, value: 25, length: 8 }];
  const long = new Array(40000).fill(0).map((_, i) => (i % 64) - 32);
  const song = parseSop(buildSop({
    version: 2, percussive: 0, chanMode, tracks,
    instruments: [pcmInstrument("LONG", long, 11025, at)],
  }));
  const make = () => new IyagiMusic({ song: buildSop({
    version: 2, percussive: 0, chanMode, tracks,
    instruments: [pcmInstrument("LONG", long, 11025, at)],
  }), sampleRate: 48000 });
  assert.equal(song.tracks[20].events.length, 4);

  // Run a player to a tick and read the sample voice's step off the mixer.
  const stepAt = (m, seconds) => {
    m.renderAll(seconds);
    return m.sequencer.pcm.voices[0].step * NATIVE_RATE;
  };
  const tick = 60 / (sopTempo(120, 8) * 8);        // seconds per tick
  // §10.6: a version-0.2 SOP starts with note 24 as the reference.
  let m = make();
  assert.equal(m.sampleVoiceCount, 4);
  assert.equal(m.sampleReference, 24);
  assert.ok(Math.abs(stepAt(m, 4 * tick) - 11025) < 1e-6, "note 24: the recorded rate");
  m = make();
  assert.ok(Math.abs(stepAt(m, 20 * tick) - 11025 * 2 ** (1 / 12)) < 1e-6, "note 25 against 24");
  m = make(); m.sampleReference = null;
  assert.ok(Math.abs(stepAt(m, 20 * tick) - 11025) < 1e-6, "null: every note as recorded");
  m = make(); m.sampleReference = 36;
  assert.ok(Math.abs(stepAt(m, 4 * tick) - 11025 / 2) < 1e-6, "an octave under the reference");

  // §10.6: by default a version-0.2 sample stops with its 8-tick note;
  // without sampleCut it outlives it.
  m = make();
  assert.equal(m.sampleCut, true);
  m.renderAll(12 * tick);
  assert.equal(m.sequencer.pcm.voices[0].playing, null);
  m = make(); m.sampleCut = false; m.renderAll(12 * tick);
  assert.equal(m.sequencer.pcm.voices[0].playing !== null, true);
});

test("sample voices have meter rows of their own, and names", () => {
  const chanMode = [...new Array(20).fill(2), 3, 3, 3, 3];
  const tracks = chanMode.map(() => []);
  tracks[21] = [{ delta: 0, code: 6, value: 0 }, { delta: 0, code: 4, value: 127 },
    { delta: 4, code: 2, value: 26, length: 16 }];
  const loud = new Array(20000).fill(0).map((_, i) => (i % 2 ? 127 : -127));
  const m = new IyagiMusic({ song: buildSop({
    version: 2, percussive: 0, chanMode, tracks,
    instruments: [pcmInstrument("LOUD", loud, 11025, 76 + 24)],
  }), sampleRate: 48000 });
  const rows = m.sampleMeterBuffer();
  assert.equal(rows.length, 4 * METER_STRIDE);
  const tick = 60 / (sopTempo(120, 8) * 8);
  m.renderAll(8 * tick);
  m.readSampleMeters(rows);
  // Track 21 is the second WAV track, so the second sample voice.
  const o = 1 * METER_STRIDE;
  assert.equal(rows[o + M_KEY_ON], 1);
  assert.equal(rows[o + M_NOTE], 26);
  assert.equal(rows[o + M_VOLUME], 127);
  assert.ok(Math.abs(rows[o + M_PEAK] - 0.5 * 127 / 128) < 0.01, "full scale is one voice's 0.5");
  assert.equal(rows[M_KEY_ON], 0, "the first sample voice is silent");
  assert.deepEqual(m.sampleNames, ["", "LOUD", "", ""]);
  m.readSampleMeters(rows);
  assert.ok(rows[o + M_PEAK] === 0, "reading takes the peak");
});

test("a sample left to ring outlives the song's end, and one its note cuts does not", () => {
  // Nothing on any track but one sample, one tick long, at tick 8. The song's
  // END is the tick after its note-off; the sample is half a second.
  const chanMode = [...new Array(20).fill(2), 3, 3, 3, 3];
  const tracks = chanMode.map(() => []);
  tracks[20] = [{ delta: 0, code: 6, value: 0 }, { delta: 8, code: 2, value: 24, length: 1 }];
  const half = new Array(Math.round(11025 / 2)).fill(0).map((_, i) => ((i * 7) % 60) - 30);
  const bytes = buildSop({
    version: 2, percussive: 0, chanMode, tracks,
    instruments: [pcmInstrument("TAIL", half, 11025, 76 + 24)],
  });
  const tick = 60 / (sopTempo(120, 8) * 8);
  const endSeconds = 10 * tick;                    // note-off at 9, END at 10

  const ring = new IyagiMusic({ song: bytes, sampleRate: 48000, sampleCut: false });
  const rung = ring.renderAll(10).length / 48000;
  assert.ok(rung >= 8 * tick + 0.5 - 0.01, `the sample plays out (${rung} s)`);
  assert.ok(ring.ended);
  // Song time is banked in whole chip samples, so it lands within one of it.
  assert.ok(Math.abs(ring.position - ring.duration) < 2 / 49716,
    `song time stops at the end (${ring.position} against ${ring.duration})`);

  const cut = new IyagiMusic({ song: bytes, sampleRate: 48000 });
  const short = cut.renderAll(10).length / 48000;
  assert.ok(short < endSeconds + 0.1, `cut ends with the song (${short} s)`);
});

test("a control-track code on a sequenced track is read, and played as Note plays it", () => {
  // §4.3: a file outside the corpus carries a tempo on track 0, at tick 0,
  // beside the control track's own. Note's reader knows codes 1..8 on every
  // track and opens it; its player takes a tempo only from the control track
  // but a global volume from anywhere.
  const tracks = new Array(N_TRACKS).fill(null).map(() => []);
  tracks[0] = [
    { delta: 0, code: 6, value: 0 },
    { delta: 0, code: 4, value: 127 },
    { delta: 0, code: 3, value: 161 },
    { delta: 0, code: 2, value: 60, length: 8 },
    { delta: 4, code: 8, value: 64 },
  ];
  const song = parseSop(buildSop({
    percussive: 0, instruments: [MELODY], tracks,
    control: [{ delta: 0, code: 3, value: 157 }],
  }));
  assert.deepEqual(song.tracks[0].events.map((e) => [e.tick, e.code, e.value]),
    [[0, 6, 0], [0, 4, 127], [0, 3, 161], [0, 2, 60], [4, 8, 64]]);
  assert.equal(song.tracks[0].events[3].length, 8, "alignment survives the stray event");

  const seq = sopSequence(song);
  assert.deepEqual(seq.filter((e) => e.type === TEMPO).map((e) => e.tempo),
    [sopTempo(157, song.tickBeat)], "only the control track's tempo plays");
  assert.deepEqual(seq.filter((e) => e.type === VOLUME).map((e) => [e.tick, e.volume]),
    [[0, 127], [4, 64]], "the track's global volume rescales it");
});

test("instrument bytes unpack into the register fields they name", () => {
  const p = sopPatch(parseSop(buildSop({ instruments: [MELODY] })).instruments[0]);
  assert.deepEqual(p.modulator, {
    ksl: 0, multiple: 0, feedback: 3, attack: 15, sustain: 2, eg: 1,
    decay: 3, release: 3, totalLevel: 16, am: 0, vib: 0, ksr: 1, connection: 1,
  });
  assert.deepEqual(p.carrier, {
    ksl: 0, multiple: 1, feedback: 3, attack: 15, sustain: 3, eg: 0,
    decay: 2, release: 3, totalLevel: 0, am: 0, vib: 0, ksr: 1, connection: 1,
  });
  // §3.2: wave select passes through as the file stores it. OPL3 values survive
  // the reader and are masked by the driver, not thrown away here.
  assert.equal(p.modWave, 7);
  assert.equal(p.carWave, 4);
  // §6: a comment is not an instrument and has no patch.
  const c = parseSop(buildSop({ instruments: [{ type: 12, longName: "x" }] }));
  assert.equal(sopPatch(c.instruments[0]), null);
});

test("a single-operator rhythm instrument keeps its modulator and feedback nibble", () => {
  // §3.2: for types 7..10 bytes 6..10 are never used, but NOTE.EXE writes byte
  // 5's low nibble to 0xC7/0xC8 for the hi-hat and tom -- and only the low
  // nibble, so the 0x90 of junk above it must not matter.
  const junk = { type: 10, shortName: "HH", data: [1, 0, 0xf8, 0xca, 2, 0x9f, 0x6f, 0x73, 0x69, 0x6e, 0x67] };
  const p = sopPatch(parseSop(buildSop({ instruments: [junk] })).instruments[0]);
  assert.equal(p.modulator.multiple, 1);
  assert.equal(p.modWave, 2);
  assert.equal(p.modulator.feedback, 7);
  assert.equal(p.modulator.connection, 0);
  assert.equal(p.carWave, 0);
  assert.deepEqual(new Set(Object.values(p.carrier)), new Set([0, 1]));
});

test("an overlapping drum hit is not struck again", () => {
  // §4.2: four bass-drum hits a tick apart, each eight ticks long. In Note the
  // drum's bit is already set when the second arrives, so the first is the
  // only strike and the drum lets go when the last note ends.
  const tracks = new Array(N_TRACKS).fill(null).map(() => []);
  tracks[6] = [{ delta: 0, code: 6, value: 0 }];
  for (let i = 0; i < 4; i++) tracks[6].push({ delta: 1, code: 2, value: 36, length: 8 });
  const seq = sopSequence(parseSop(buildSop({
    percussive: 1, instruments: [{ ...MELODY, type: 6 }], tracks,
  })));
  const ons = seq.filter((e) => e.type === NOTE_ON);
  assert.deepEqual(ons.map((e) => e.legato), [false, true, true, true]);
  assert.deepEqual(seq.filter((e) => e.type === NOTE_OFF).map((e) => e.tick), [12]);
});

test("an overlapping note slurs and a touching one is struck", () => {
  const tracks = new Array(N_TRACKS).fill(null).map(() => []);
  tracks[0] = [
    { delta: 0, code: 6, value: 0 },
    { delta: 0, code: 2, value: 60, length: 8 },
    { delta: 4, code: 2, value: 62, length: 8 },    // starts inside the first
    { delta: 8, code: 2, value: 64, length: 4 },    // starts where the second ends
  ];
  const seq = sopSequence(parseSop(buildSop({ percussive: 0, instruments: [MELODY], tracks })));
  assert.deepEqual(seq.filter((e) => e.type === NOTE_ON).map((e) => [e.tick, e.legato]),
    [[0, false], [4, true], [12, false]]);
  assert.deepEqual(seq.filter((e) => e.type === NOTE_OFF).map((e) => e.tick), [12, 16]);
});

test("the sequence follows NOTE.EXE's defaults and its choice of tracks", () => {
  const tracks = new Array(N_TRACKS).fill(null).map(() => []);
  tracks[0] = [{ delta: 0, code: 6, value: 1 }, { delta: 0, code: 2, value: 60, length: 4 }];
  tracks[3] = [{ delta: 0, code: 6, value: 1 }, { delta: 0, code: 2, value: 64, length: 4 }];
  tracks[1] = [{ delta: 0, code: 6, value: 1 }, { delta: 0, code: 6, value: 0 },
    { delta: 0, code: 2, value: 67, length: 4 }];
  const chanMode = new Array(N_TRACKS).fill(2);
  chanMode[0] = 1; chanMode[3] = 0;              // track 3 is track 0's upper half
  const song = parseSop(buildSop({
    percussive: 0, chanMode, tracks,
    instruments: [{ type: 12, longName: "credits" }, { ...MELODY, type: 0, data: [...MELODY.data, ...MELODY.data] }],
  }));
  const seq = sopSequence(song, { melodicVoices: 18, rhythmBase: 18, fourOpPairs: [[0, 3], [1, 4]] });
  // §2: mode 0 is not played.
  assert.deepEqual(seq.filter((e) => e.type === NOTE_ON).map((e) => e.note).sort(), [60, 67]);
  // §4.2: 96 before any volume event.
  assert.ok(seq.filter((e) => e.type === VOLUME).every((e) => e.volume === 96));
  // §2, §3.3: only the mode-1 track's pair is joined; the other track's
  // four-operator instrument goes to a voice that is not. Selecting the empty
  // slot 0 changed nothing.
  const patches = seq.filter((e) => e.type === PATCH);
  assert.deepEqual(patches.map((e) => e.wide), [true, false]);
  assert.ok(patches.every((e) => e.patch.pair));
});

test("a corrupt pan value silences the channel and damages its feedback", () => {
  const tracks = new Array(N_TRACKS).fill(null).map(() => []);
  tracks[0] = [{ delta: 0, code: 6, value: 0 }, { delta: 0, code: 7, value: 9 },
    { delta: 0, code: 2, value: 60, length: 4 }];
  const seq = sopSequence(parseSop(buildSop({ percussive: 0, instruments: [MELODY], tracks })));
  const pan = seq.find((e) => e.type === PAN);
  assert.equal(pan.pan, PAN_NONE);
  assert.equal(pan.garble, 9);
});

test("Note's timer is where SOP tempo comes from", () => {
  // §5: 120 bpm is a divisor of 2485 on a 1.193182 MHz timer.
  assert.ok(Math.abs(sopTempo(120, 8) - 120.0383) < 1e-3);
  // Under 19 Hz the timer stays at 18.2 Hz: tempos 2..4 all play alike.
  assert.equal(sopTempo(2, 8), sopTempo(4, 8));
  assert.ok(Math.abs(sopTempo(4, 8) - 4.5516) < 1e-3);
});

test("a track that never selects an instrument still sounds", () => {
  // ST-BGM.SOP has 4878 notes and not one event 6. Without a fallback the
  // voice keeps the driver's zeroed registers and the whole song is silent.
  const tracks = new Array(N_TRACKS).fill(null).map(() => []);
  tracks[0] = [{ delta: 0, code: 4, value: 127 }, { delta: 4, code: 2, value: 60, length: 8 }];
  const seq = sopSequence(parseSop(buildSop({
    percussive: 0, instruments: [{ type: 12, longName: "credits" }, MELODY], tracks,
  })));
  const patch = seq.find((e) => e.type === PATCH);
  assert.ok(patch, "no patch was loaded for a track that never selected one");
  // The comment at index 0 is not a patch, so the fallback is the melody at 1.
  assert.equal(patch.patch.name, "PIANO");
});

test("the sequencer keeps every note inside the chip's voices", () => {
  const tracks = new Array(N_TRACKS).fill(null).map((_, t) => ([
    { delta: 0, code: 6, value: 0 },
    { delta: t, code: 2, value: 48 + t, length: 64 },
  ]));
  // Twenty tracks all sounding at once, against six melodic voices.
  const song = parseSop(buildSop({ percussive: 1, instruments: [MELODY], tracks }));
  const seq = sopSequence(song);
  for (const e of seq) {
    if (e.voice !== undefined) assert.ok(e.voice >= 0 && e.voice <= 10, `voice ${e.voice}`);
  }
  assert.ok(seq.some((e) => e.type === NOTE_ON), "no notes came out");
  // Ticks must be sorted, or the sequencer's single-pass drain silently drops
  // everything that arrived late.
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i].tick >= seq[i - 1].tick);
  // A stolen voice is released before it is keyed again: no voice may be keyed
  // on twice at the same tick without a note-off in between.
  const held = new Set();
  for (const e of seq) {
    if (e.type === NOTE_ON) {
      assert.ok(!held.has(e.voice) || e.legato, `voice ${e.voice} keyed twice at tick ${e.tick}`);
      held.add(e.voice);
    } else if (e.type === NOTE_OFF) held.delete(e.voice);
  }
});

test("in SOP mode the driver writes what NOTE.EXE writes", () => {
  const writes = [];
  const chip = { opl3: true, write: (reg, value) => writes.push([reg, value]) };
  const d = new AdlibDriver(chip, { opl3: true, sop: true });
  const two = sopPatch(parseSop(buildSop({ instruments: [MELODY] })).instruments[0]);
  const four = { ...two, pair: two };
  const last = (reg) => writes.filter(([r]) => r === reg).at(-1)?.[1];

  // §4.2: MIDI 60 is Note's row 0, F-number 343, block 4 -- and a pitch that is
  // not a multiple of four plays as the one below it.
  d.setVoiceTimbre(0, two, false);
  d.noteOn(0, 60);
  assert.equal(last(0xa0), 343 & 0xff);
  assert.equal(last(0xb0), 0x20 | (4 << 2) | (343 >> 8));
  d.setVoicePitch(0, 103);
  assert.equal(last(0xa0), 343 & 0xff);
  d.setVoicePitch(0, 0);                           // a semitone down: B, block 3
  assert.equal(last(0xb0) & 0x1c, 3 << 2);

  // §3.3: a two-operator patch on a joined pair leaves the pair joined and the
  // second half's operators untouched.
  const [head] = d.fourOpPairs[0];
  d.setVoiceTimbre(head, four, true);
  assert.ok(last(0x104) & 1);
  writes.length = 0;
  d.setVoiceTimbre(head, two, true);
  assert.equal(last(0x104), undefined, "the pair was split or rejoined");
  assert.ok(d.voiceFourOp[head] && d.voiceHalf[head]);
  const touched = new Set(writes.map(([r]) => r & 0xff));
  for (const reg of [0x28, 0x2b, 0x48, 0x4b, 0x68, 0x6b]) {
    assert.ok(!touched.has(reg), `slave operator register 0x${reg.toString(16)} written`);
  }

  // §4.2: a pan value Note does not know clears both switches and ORs its low
  // nibble into feedback and connection, until the next patch -- which mends
  // the feedback but, as in Note, not the switches.
  d.setVoiceTimbre(1, two, false);
  const c0 = last(0xc1);
  d.setVoicePan(1, PAN_NONE, 9);
  assert.equal(last(0xc1), (c0 & 0x0f) | 9);
  d.setVoiceTimbre(1, two, false);
  assert.equal(last(0xc1), c0 & 0x0f);
});

/* ---------------------------------------------------------------- corpus */

test("every corpus SOP parses and ends exactly where the file does",
  { skip: !have }, () => {
    const files = sopFiles();
    let events = 0, comments = 0, fourOp = 0;
    for (const fn of files) {
      const b = read(fn);
      assert.equal(identify(b), "sop", fn);
      const s = parseSop(b);
      assert.equal(sopByteLength(s), b.length, `${fn}: the walk ends where the file does`);
      assert.deepEqual(s.version, [0, 1], fn);
      assert.equal(s.tracks.length, 20, fn);
      for (const t of s.tracks) events += t.events.length;
      events += s.control.length;
      comments += s.comments.length;
      fourOp += s.instruments.filter((i) => i.type === 0).length;
    }
    assert.equal(files.length, 347);
    assert.equal(events, 4874279);
    assert.equal(comments, 12030);
    assert.equal(fourOp, 608);
  });

test("the corpus stays inside the documented value ranges", { skip: !have }, () => {
  const seen = { chanMode: new Set(), instType: new Set(), track: new Set(), ctrl: new Set() };
  let notes = 0, maxNote = 0, minNote = 255, maxVolume = 0, maxPitch = 0, oor = 0;
  let percussive = 0;
  for (const fn of sopFiles()) {
    const s = parseSop(read(fn));
    if (s.percussive) percussive++;
    for (const t of s.tracks) {
      seen.chanMode.add(t.modeRaw);
      for (const e of t.events) {
        seen.track.add(e.code);
        if (e.code === 2) { notes++; maxNote = Math.max(maxNote, e.value); minNote = Math.min(minNote, e.value); }
        if (e.code === 4) maxVolume = Math.max(maxVolume, e.value);
        if (e.code === 5) maxPitch = Math.max(maxPitch, e.value);
        if (e.code === 6 && e.value >= s.instruments.length) oor++;
      }
    }
    for (const e of s.control) seen.ctrl.add(e.code);
    for (const i of s.instruments) seen.instType.add(i.type);
  }
  assert.deepEqual([...seen.instType].sort((a, b) => a - b), [0, 1, 6, 7, 8, 9, 10, 12]);
  assert.deepEqual([...seen.track].sort((a, b) => a - b), [1, 2, 4, 5, 6, 7]);
  assert.deepEqual([...seen.ctrl].sort((a, b) => a - b), [3, 8]);
  // §2: 0x82 is mode 2 with the editor's disable bit set; nothing else carries it.
  assert.deepEqual([...seen.chanMode].sort((a, b) => a - b), [0, 1, 2, 0x82]);
  assert.equal(percussive, 306);
  assert.equal(notes, 2162144);
  assert.equal(minNote, 12);
  assert.equal(maxNote, 113);
  assert.equal(maxVolume, 127, "volume is 7-bit, like the driver's");
  assert.equal(maxPitch, 200, "§4.2: pitch is 0..200 about a centre of 100");
  // §7: seven files select an instrument they do not have. A player has to
  // survive it, so this is pinned rather than asserted away.
  assert.equal(oor, 324);
});

test("HTS starts at 255 bpm, and fifteen songs feel it", { skip: !have }, () => {
  // §5: HTS programs its timer with 255 at the start of a SOP, where Note and
  // this library use 120, so what matters is how many songs play notes before
  // their control track sets a tempo. Fifteen do; five never set one.
  let late = 0, never = 0;
  for (const fn of sopFiles()) {
    const tempos = parseSop(read(fn)).control.filter((e) => e.code === 3);
    if (!tempos.length) never++;
    else if (tempos[0].tick !== 0) late++;
  }
  assert.equal(late + never, 15);
  assert.equal(never, 5);
});

test("a corpus SOP renders audible audio", { skip: !have }, () => {
  for (const fn of ["2REBIBLE.SOP", "4OPDANCE.SOP", "JE-ISAK2.SOP"]) {
    // No `chip` option: a .sop gets the YMF262 it was written for.
    const m = new IyagiMusic({ song: read(fn), sampleRate: 48000 });
    assert.equal(m.kind, "sop");
    assert.deepEqual(m.missing, [], `${fn}: a SOP carries its own instruments`);
    const pcm = m.renderAll(5);
    const rms = Math.sqrt(pcm.reduce((s, v) => s + v * v, 0) / pcm.length);
    assert.ok(rms > 0.005, `${fn}: effectively silent (rms ${rms})`);
    const clipped = pcm.reduce((n, v) => n + (Math.abs(v) >= 0.999 ? 1 : 0), 0);
    assert.ok(clipped < pcm.length * 0.001, `${fn}: ${clipped} clipped samples`);
  }
});

test("a four-op SOP still plays on the OPL2's first operator pair",
  { skip: !have }, () => {
    // §8: 61 corpus files carry four-op instruments, and a YM3812 has nowhere
    // to put the second pair. Half an instrument is still an instrument, so
    // this must not throw and must not go silent -- the reduction is a
    // documented fallback, not a dead branch. What an OPL3 does with the same
    // files is `opl3.test.js`.
    const fn = sopFiles().find((f) => parseSop(read(f)).instruments.some((i) => i.type === 0));
    const song = parseSop(read(fn));
    const four = song.instruments.find((i) => i.type === 0);
    assert.equal(four.data.length, 22);
    const p = sopPatch(four);
    assert.ok(p, "a four-op instrument must still yield a patch");
    assert.ok(p.modWave <= 7 && p.carWave <= 7, "§3.3: bytes 4 and 10 are wave selects");
    assert.ok(p.pair, "§3.3: the second operator pair belongs to the patch");
    const m = new IyagiMusic({ song: read(fn), sampleRate: 48000, chip: "opl2" });
    assert.equal(m.chip.opl3, false);
    const pcm = m.renderAll(5);
    assert.ok(Math.sqrt(pcm.reduce((s, v) => s + v * v, 0) / pcm.length) > 0.005, `${fn}: silent`);
  });

test("the four version-0.2 files parse to their last byte and play their FM part",
  { skip: !haveV02 }, () => {
    // §10, measured over these four: 24 tracks, modes 2 then 3, six PCM
    // records whose stored offset is where their head ends, and every pan 64
    // but two.
    const pcms = [];
    for (const fn of V02_FILES) {
      const b = new Uint8Array(fs.readFileSync(path.join(V02, fn)));
      const s = parseSop(b);
      assert.equal(sopByteLength(s), b.length, `${fn}: the walk ends where the file does`);
      assert.deepEqual(s.version, [0, 2], fn);
      assert.deepEqual(s.tracks.map((t) => t.mode), [...new Array(20).fill(2), 3, 3, 3, 3], fn);
      let at = 76 + 24;
      for (const inst of s.instruments) {
        if (inst.pcm) {
          const stored = new DataView(inst.data.buffer, inst.data.byteOffset).getUint32(0, true);
          assert.equal(stored, at + 28 + 19, `${fn} ${inst.shortName}: dataOffset`);
          pcms.push([inst.shortName, inst.pcm.rate, inst.pcm.samples.length]);
        }
        at += 28 + inst.data.length;
      }
      const pans = s.tracks.flatMap((t) => t.events.filter((e) => e.code === 7).map((e) => e.value));
      assert.equal(pans.filter((v) => v !== 64).length, fn === "op.sop" ? 2 : 0, fn);

      const m = new IyagiMusic({ song: b, sampleRate: 48000 });
      assert.equal(m.sampleVoiceCount, 4, fn);
      const pcmNotes = sopSequence(s).filter((e) => e.pcm && e.type === NOTE_ON).length;
      assert.equal(pcmNotes, { "ending.sop": 1, "op.sop": 8 }[fn] ?? 0, fn);
      if (fn === "mute.sop") continue;                   // one note, at volume 0
      const pcm = m.renderAll(6);
      const rms = Math.sqrt(pcm.reduce((n, v) => n + v * v, 0) / pcm.length);
      assert.ok(rms > 0.005, `${fn}: effectively silent (rms ${rms})`);
    }
    assert.deepEqual(pcms, [
      ["EXPLO02", 11025, 30832],
      ["EF01", 11025, 12976], ["SF", 11025, 8275], ["EXPRO1", 8050, 6856],
      ["EVER", 11025, 6728], ["SF02", 11025, 5156],
    ]);
  });
