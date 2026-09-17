// SOP checks. The first half builds files in code, so it runs on a clean
// checkout; the second half pins what the corpus measures, because every
// *(measured)* claim in docs/SOP_FORMAT.en.md is only as good as something
// that fails when it stops being true.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { IyagiMusic, parseSop, sopPatch, identify } from "../src/player.js";
import { sopSequence, NOTE_ON, NOTE_OFF, PATCH } from "../src/sequencer.js";
import { FormatError } from "../src/formats.js";

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

test("a single-operator rhythm instrument drops its uninitialised half", () => {
  // §3.2: for types 7..10 everything from the feedback byte on is stack junk.
  const junk = { type: 10, shortName: "HH", data: [1, 0, 0xf8, 0xca, 2, 0x9f, 0x6f, 0x73, 0x69, 0x6e, 0x67] };
  const p = sopPatch(parseSop(buildSop({ instruments: [junk] })).instruments[0]);
  assert.equal(p.modulator.multiple, 1);
  assert.equal(p.modWave, 2);
  assert.equal(p.modulator.feedback, 0, "feedback byte 0x9f must not reach the chip");
  assert.equal(p.carWave, 0);
  assert.deepEqual(new Set(Object.values(p.carrier)), new Set([0, 1]));
});

test("repeated hits on one drum do not cut each other off", () => {
  // Four bass-drum hits a tick apart, each eight ticks long: without pulling
  // each note-off back to the next hit, the first one's off lands mid-way
  // through the fourth and silences it.
  const tracks = new Array(N_TRACKS).fill(null).map(() => []);
  tracks[6] = [{ delta: 0, code: 6, value: 0 }];
  for (let i = 0; i < 4; i++) tracks[6].push({ delta: 1, code: 2, value: 36, length: 8 });
  const seq = sopSequence(parseSop(buildSop({
    percussive: 1, instruments: [{ ...MELODY, type: 6 }], tracks,
  })));
  let on = 0;
  for (const e of seq) {
    if (e.type === NOTE_ON) { assert.equal(on, 0, `bass drum keyed at tick ${e.tick} while held`); on = 1; }
    if (e.type === NOTE_OFF) on = 0;
  }
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
      assert.ok(!held.has(e.voice), `voice ${e.voice} keyed twice at tick ${e.tick}`);
      held.add(e.voice);
    } else if (e.type === NOTE_OFF) held.delete(e.voice);
  }
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
    assert.equal(files.length, 336);
    assert.equal(events, 4691270);
    assert.equal(comments, 11393);
    assert.equal(fourOp, 415);
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
  // §2: 0x82 is the undocumented one -- mode 2 with bit 7 set, nothing else.
  assert.deepEqual([...seen.chanMode].sort((a, b) => a - b), [0, 1, 2, 0x82]);
  assert.equal(percussive, 295);
  assert.equal(notes, 2076497);
  assert.equal(minNote, 12);
  assert.equal(maxNote, 113);
  assert.equal(maxVolume, 127, "volume is 7-bit, like the driver's");
  assert.equal(maxPitch, 200, "§4.2: pitch is 0..200 about a centre of 100");
  // §7: seven files select an instrument they do not have. A player has to
  // survive it, so this is pinned rather than asserted away.
  assert.equal(oor, 324);
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
