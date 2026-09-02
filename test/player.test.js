// End-to-end checks against the reference corpus. Skipped when it is absent,
// so the suite still runs on a clean checkout.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  IyagiMusic, parseIms, parseBnk, parseIss, deltaGcd, identify, resolveIssSpans,
  METER_STRIDE, M_PEAK, M_VOLUME,
} from "../src/player.js";

const CORPUS = "/home/torvald/Documents/tsvm/reference_materials/Iyagi Music Sound";
const have = fs.existsSync(CORPUS);
const read = (p) => new Uint8Array(fs.readFileSync(path.join(CORPUS, p)));
const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

test("identifies each file type by content", { skip: !have }, () => {
  assert.equal(identify(read("ZZ-BLCAT.IMS")), "ims");
  assert.equal(identify(read("STANDARD.BNK")), "bnk");
  assert.equal(identify(read("SV-10TH.ROL")), "rol");
  assert.equal(identify(read("IMS_FILE_MEGA_COLLECTION/000-TEMA.ISS")), "iss");
});

test("decodes a Johab title and resolves every patch", { skip: !have }, () => {
  const m = new IyagiMusic({ song: read("ZZ-BLCAT.IMS"), fallbackBank: read("STANDARD.BNK") });
  assert.equal(m.title.trim(), "검은 고양이 네로        Turbo".trim());
  assert.deepEqual(m.missing, []);
});

test("the delta-time GCD agrees with the header's srcTickBeat", { skip: !have }, () => {
  const root = path.join(CORPUS, "IMS_FILE_MEGA_COLLECTION");
  let checked = 0;
  for (const fn of fs.readdirSync(root)) {
    if (!fn.toUpperCase().endsWith(".IMS")) continue;
    const song = parseIms(new Uint8Array(fs.readFileSync(path.join(root, fn))));
    if (!song.srcTickBeat) continue;
    assert.equal(deltaGcd(song), 240 / song.srcTickBeat, fn);
    checked++;
  }
  assert.ok(checked > 50, `only ${checked} files carry srcTickBeat`);
});

test("renders IMS and ROL songs without clipping or silence", { skip: !have }, () => {
  const std = read("STANDARD.BNK");
  const cases = [
    ["ZZ-BLCAT.IMS", null], ["TAKEONME.IMS", null],
    ["SV-10TH.ROL", "SV-10TH.BNK"],
  ];
  for (const [song, bank] of cases) {
    const m = new IyagiMusic({
      song: read(song), bank: bank ? read(bank) : undefined, fallbackBank: std,
      sampleRate: 48000,
    });
    const pcm = m.renderAll(10);
    assert.ok(pcm.length > 48000 * 9, `${song}: only ${pcm.length} samples`);
    assert.ok(rms(pcm) > 0.005, `${song}: effectively silent`);
    const clipped = pcm.reduce((n, v) => n + (Math.abs(v) >= 0.999 ? 1 : 0), 0);
    assert.ok(clipped < pcm.length * 0.001, `${song}: ${clipped} clipped samples`);
  }
});

test("every corpus bank parses and every patch name resolves", { skip: !have }, () => {
  const std = parseBnk(read("STANDARD.BNK"));
  const root = path.join(CORPUS, "IMS_FILE_MEGA_COLLECTION");
  let songs = 0, refs = 0, missing = 0;
  for (const fn of fs.readdirSync(root)) {
    if (!fn.toUpperCase().endsWith(".IMS")) continue;
    const p = path.join(root, fn);
    const lp = p.replace(/\.[^.]+$/, ".BNK");
    const local = fs.existsSync(lp) ? parseBnk(new Uint8Array(fs.readFileSync(lp))) : null;
    const song = parseIms(new Uint8Array(fs.readFileSync(p)));
    for (const name of song.patchNames) {
      refs++;
      const key = name.toUpperCase();
      if (!local?.byName.get(key) && !std.byName.get(key)) missing++;
    }
    songs++;
  }
  assert.equal(songs, 1128);
  assert.ok(missing / refs < 0.001, `${missing} of ${refs} patch names unresolved`);
});

test("ISS credit fields are tool defaults, not credits", { skip: !have }, () => {
  // Pinned because the page suppresses exactly this set: if a corpus turns up
  // that carries real credits, this fails and the suppression list is wrong.
  const root = path.join(CORPUS, "IMS_FILE_MEGA_COLLECTION");
  const seen = { writer: new Set(), composer: new Set(), singer: new Set(), editor: new Set() };
  let files = 0;
  for (const fn of fs.readdirSync(root)) {
    if (!fn.toUpperCase().endsWith(".ISS")) continue;
    const iss = parseIss(new Uint8Array(fs.readFileSync(path.join(root, fn))));
    if (!iss) continue;
    files++;
    for (const k of Object.keys(seen)) if (iss[k].trim()) seen[k].add(iss[k].trim());
  }
  assert.equal(files, 680);
  assert.deepEqual([...seen.composer].sort(), ["COMPOSER", "Solgher"]);
  assert.deepEqual([...seen.singer].sort(), ["Damul", "SINGER"]);
  assert.deepEqual([...seen.editor].sort(), ["EDITOR", "Salmosa"]);
  assert.deepEqual([...seen.writer].sort(), ["KimTH", "LeeYS", "MunBK", "WRITER"]);
});

test("an ISS cue is the right edge of the highlight, not an isolated run", { skip: !have }, () => {
  const root = path.join(CORPUS, "IMS_FILE_MEGA_COLLECTION");
  const iss = parseIss(new Uint8Array(fs.readFileSync(path.join(root, "AGP-DEUX.ISS"))));
  const spans = resolveIssSpans(iss);

  // An ordinary lyric line wipes left to right: the region only ever grows.
  const lyric = spans.filter((s, i) => iss.cues[i].line === 11);
  assert.ok(lyric.length > 5);
  assert.ok(lyric.every((s) => s.from === lyric[0].from), "the left edge should stay put");
  assert.ok(lyric.every((s, i) => i === 0 || s.to >= lyric[i - 1].to), "the wipe should not retreat");

  // The DEUX banner uses the same records as an animation: its right edge runs
  // out and comes back, which is what reads as a volume meter.
  const banner = spans.filter((s, i) => iss.cues[i].line === 60).slice(0, 30);
  const edges = banner.map((s) => s.to);
  assert.ok(Math.max(...edges) - Math.min(...edges) > 12, "the bar should have real travel");
  let reversals = 0;
  for (let i = 2; i < edges.length; i++) {
    if (Math.sign(edges[i] - edges[i - 1]) !== Math.sign(edges[i - 1] - edges[i - 2])) reversals++;
  }
  assert.ok(reversals >= 3, `the bar should bounce; saw ${reversals} reversals`);
});

test("ISS cues tile a lyric line contiguously", { skip: !have }, () => {
  // The evidence for the accumulating reading: cue runs abut each other rather
  // than scattering, so they describe one growing region.
  const root = path.join(CORPUS, "IMS_FILE_MEGA_COLLECTION");
  let abutting = 0, total = 0;
  for (const fn of fs.readdirSync(root)) {
    if (!fn.toUpperCase().endsWith(".ISS")) continue;
    const iss = parseIss(new Uint8Array(fs.readFileSync(path.join(root, fn))));
    if (!iss) continue;
    const byLine = new Map();
    for (const c of iss.cues) (byLine.get(c.line) ?? byLine.set(c.line, []).get(c.line)).push(c);
    for (const cs of byLine.values()) {
      if (cs.length < 3 || cs.length > 60) continue;
      for (let i = 1; i < cs.length; i++) {
        const gap = cs[i].startX - (cs[i - 1].startX + cs[i - 1].widthX);
        total++;
        if (gap === 0 || gap === 1) abutting++;
      }
    }
  }
  assert.ok(abutting / total > 0.75, `only ${(100 * abutting / total).toFixed(1)}% of cues abut`);
});

test("the meters follow what the song actually plays", { skip: !have }, () => {
  // SHC uses all eleven voices, drums included, inside its first fifteen
  // seconds -- which is what makes it the one to check the rhythm rows on.
  const m = new IyagiMusic({ song: read("SHC.IMS"), fallbackBank: read("STANDARD.BNK") });
  assert.equal(m.voiceCount, 11);
  const meter = IyagiMusic.meterBuffer();
  const block = new Float32Array(4800);
  const peak = new Float64Array(11);
  const volume = new Float64Array(11);
  for (let i = 0; i < 150; i++) {
    m.render(block, 0, block.length);
    m.readMeters(meter);
    for (let v = 0; v < 11; v++) {
      peak[v] = Math.max(peak[v], meter[v * METER_STRIDE + M_PEAK]);
      volume[v] = Math.max(volume[v], meter[v * METER_STRIDE + M_VOLUME]);
    }
  }
  for (let v = 0; v < 11; v++) {
    if (v === 8) continue;                       // this song never hits the tom
    assert.ok(peak[v] > 0.01, `voice ${v} never metered: ${peak[v]}`);
    assert.ok(volume[v] > 0, `voice ${v} reported no channel volume`);
  }
  assert.ok(peak[8] === 0, "the tom sounded in a song that does not use it");
  // Every voice has been given a bank patch, and the epoch moved as it happened.
  assert.equal(m.patchNames.filter(Boolean).length, 11);
  assert.ok(m.patchEpoch > 11);
});
