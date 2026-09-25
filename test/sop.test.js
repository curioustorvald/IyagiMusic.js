// SOP checks. The first half builds files in code, so it runs on a clean
// checkout; the second half pins what the corpus measures, because every
// *(measured)* claim in docs/SOP_FORMAT.en.md is only as good as something
// that fails when it stops being true.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { IyagiMusic, parseSop, sopPatch, identify } from "../src/player.js";
import { sopSequence, sopTempo, NOTE_ON, NOTE_OFF, PATCH, PAN, VOLUME } from "../src/sequencer.js";
import { PAN_NONE } from "../src/opl/constants.js";
import { FormatError } from "../src/formats.js";
import { AdlibDriver } from "../src/driver.js";

const CORPUS = "/home/torvald/Documents/tsvm/reference_materials/Iyagi Music Sound";
const MEGA = path.join(CORPUS, "IMS_FILE_MEGA_CORPUS");
const have = fs.existsSync(MEGA);
const sopFiles = () =>
  fs.readdirSync(MEGA).filter((f) => f.toUpperCase().endsWith(".SOP")).sort();
const read = (fn) => new Uint8Array(fs.readFileSync(path.join(MEGA, fn)));

/* ------------------------------------------------------------- synthetic */

const N_TRACKS = 20;

/** Build a SOP by hand, so the reader is checked against the spec, not a file. */
function buildSop({
  title = "TEST", fileName = "TEST.SOP", percussive = 1, tickBeat = 8,
  beatMeasure = 4, basicTempo = 120, chanMode = new Array(N_TRACKS).fill(2),
  instruments = [], tracks = new Array(N_TRACKS).fill(null).map(() => []),
  control = [],
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

  put(..."sopepos".split("").map((c) => c.charCodeAt(0)), 0, 1, 0);
  put(...str(fileName, 13), ...str(title, 31));
  put(percussive, 0, tickBeat, 0, beatMeasure, basicTempo);
  put(...str("", 13), N_TRACKS, instruments.length, 0);
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
      // parseSop throws if the control track does not land on the last byte,
      // so reaching here is the whole check; the rest is the shape of it.
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
