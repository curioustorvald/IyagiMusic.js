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
import { imsEvents } from "../src/formats.js";
import { imsSequence, END } from "../src/sequencer.js";

const CORPUS = "/home/torvald/Documents/tsvm/reference_materials/Iyagi Music Sound";
// The bulk of the corpus lives in one subdirectory. Its name has changed once
// already, so `have` checks for it rather than for CORPUS: the parent surviving
// a rename underneath it turns every corpus test from a skip into a failure.
const MEGA = path.join(CORPUS, "IMS_FILE_MEGA_CORPUS");
const have = fs.existsSync(MEGA);
const read = (p) => new Uint8Array(fs.readFileSync(path.join(CORPUS, p)));
const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

test("identifies each file type by content", { skip: !have }, () => {
  assert.equal(identify(read("ZZ-BLCAT.IMS")), "ims");
  assert.equal(identify(read("STANDARD.BNK")), "bnk");
  assert.equal(identify(read("SV-10TH.ROL")), "rol");
  assert.equal(identify(read("IMS_FILE_MEGA_CORPUS/000-TEMA.ISS")), "iss");
});

test("decodes a Johab title and resolves every patch", { skip: !have }, () => {
  const m = new IyagiMusic({ song: read("ZZ-BLCAT.IMS"), fallbackBank: read("STANDARD.BNK") });
  assert.equal(m.title.trim(), "검은 고양이 네로        Turbo".trim());
  assert.deepEqual(m.missing, []);
});

test("the delta-time GCD agrees with the header's srcTickBeat", { skip: !have }, () => {
  const root = MEGA;
  let checked = 0;
  for (const fn of fs.readdirSync(root)) {
    if (!fn.toUpperCase().endsWith(".IMS")) continue;
    const song = parseIms(new Uint8Array(fs.readFileSync(path.join(root, fn))));
    if (!song.srcTickBeat) continue;
    // FILE_FORMATS §1.5: a few files are damaged part-way through their
    // stream -- a status byte no IMS carries, a data byte with bit 7 set, or
    // no FC at the end. The rule is about what a converter wrote, so a file
    // whose bytes are no longer what it wrote is not evidence either way.
    // AUTUMN.IMS's intact first thousand events do obey it.
    const ev = [...imsEvents(song)];
    const damaged = !ev.length || ev.at(-1).status !== 0xfc ||
      ev.some((e) => (e.status > 0xf0 && e.status !== 0xfc) ||
        (e.status < 0xf0 && (e.a > 127 || e.b > 127)));
    if (damaged) continue;
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
  const root = MEGA;
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
  assert.equal(songs, 1725);
  assert.ok(missing / refs < 0.001, `${missing} of ${refs} patch names unresolved`);
});

test("ISS credit fields are tool defaults, not credits", { skip: !have }, () => {
  // Pinned because the page suppresses exactly this set: if a corpus turns up
  // that carries real credits, this fails and the suppression list is wrong.
  const root = MEGA;
  const seen = { writer: new Set(), composer: new Set(), singer: new Set(), editor: new Set() };
  let files = 0;
  for (const fn of fs.readdirSync(root)) {
    if (!fn.toUpperCase().endsWith(".ISS")) continue;
    const iss = parseIss(new Uint8Array(fs.readFileSync(path.join(root, fn))));
    if (!iss) continue;
    files++;
    // FILE_FORMATS §4.1: GOODDAY.ISS carries lyric text where the header
    // should be. IMPLAY reads it, so the header description is what is
    // incomplete there, and until it is, its "fields" are not fields.
    if (fn.toUpperCase() === "GOODDAY.ISS") continue;
    for (const k of Object.keys(seen)) {
      const v = iss[k].trim();
      // §4.1: a picture's file name sits in the writer field of a few old files.
      if (v && !(k === "writer" && /\.PCX$/i.test(v))) seen[k].add(v);
    }
  }
  assert.equal(files, 1031);
  // §4.1: "This / is song / text / for IMP" is an older tool's default, one
  // phrase spread over the four fields.
  assert.deepEqual([...seen.composer].sort(), ["COMPOSER", "Solgher", "is song"]);
  assert.deepEqual([...seen.singer].sort(), ["Damul", "SINGER", "text"]);
  assert.deepEqual([...seen.editor].sort(), ["EDITOR", "Salmosa", "for IMP"]);
  assert.deepEqual([...seen.writer].sort(), ["KimTH", "LeeYS", "MunBK", "This", "WRITER"]);
});

test("an ISS cue paints its own cells, and only IMPLAY's two rules clear them", { skip: !have }, () => {
  // FILE_FORMATS §4.2, from IMPLAY's disassembly. Each case below is what
  // IMPLAY shows on screen for AGP-DEUX.ISS.
  const iss = parseIss(new Uint8Array(fs.readFileSync(path.join(MEGA, "AGP-DEUX.ISS"))));
  const spans = resolveIssSpans(iss);
  const cells = (text) => [...text].flatMap((ch) => (ch.codePointAt(0) >= 0x80 ? [ch, ""] : [ch]));
  const litText = (span) => {
    const c = cells(iss.lines[span.line]);
    return span.runs.map(([a, b]) => c.slice(a, b).join(""));
  };
  const lastOn = (line) => spans.findLast((s) => s.line === line);

  // Line 18 wipes left to right, but no record covers the parentheses, so
  // they never light: "둘러 싸여져 있는데 -- (워 - ----)".
  const wipe = litText(lastOn(18));
  assert.ok(wipe.includes("워"));
  assert.ok(!wipe.join("").includes("(") && !wipe.join("").includes(")"));

  // "F.o.n.y △ S.e.r.y": one record per letter, so only the eight letters.
  assert.deepEqual(litText(spans.find((s) => s.line === 62 && s.runs.length)).join(""), "FonySery");

  // The D · E · U · X banner: a record starting left of the last one's end
  // clears the line, so what is lit keeps shrinking back instead of filling
  // once and staying -- a light that travels and flashes.
  const banner = spans.filter((s) => s.line === 60);
  const litCount = (s) => s.runs.reduce((n, [a, b]) => n + b - a, 0);
  let clears = 0;
  for (let i = 1; i < banner.length; i++) if (litCount(banner[i]) < litCount(banner[i - 1])) clears++;
  assert.ok(clears > 200, `the banner cleared only ${clears} times in ${banner.length} records`);
});

test("old-header ISS files store ticks in tenths, and IMPLAY scales them", { skip: !have }, () => {
  // FILE_FORMATS §4.1-4.2: without "IMPlay Song V" in the header IMPLAY takes
  // the tick field as tick / 10. Read that way, the old files' last records
  // land where the V2 files' do, near the end of their song.
  const ratios = { v2: [], old: [] };
  for (const fn of fs.readdirSync(MEGA)) {
    if (!/\.ISS$/i.test(fn)) continue;
    const ims = fs.readdirSync(MEGA).find((f) => f.toUpperCase() === fn.toUpperCase().replace(/ISS$/, "IMS"));
    if (!ims) continue;
    const iss = parseIss(new Uint8Array(fs.readFileSync(path.join(MEGA, fn))));
    if (!iss?.cues.length) continue;
    let song;
    try { song = parseIms(new Uint8Array(fs.readFileSync(path.join(MEGA, ims)))); } catch { continue; }
    let end = 0;
    for (const e of imsEvents(song)) end = e.tick;
    if (end) ratios[iss.v2 ? "v2" : "old"].push(iss.cues.at(-1).tick / end);
  }
  const median = (a) => a.sort((x, y) => x - y)[a.length >> 1];
  assert.ok(ratios.old.length > 100 && ratios.v2.length > 500);
  assert.ok(Math.abs(median(ratios.old) - median(ratios.v2)) < 0.05,
    `old ${median(ratios.old).toFixed(3)} vs V2 ${median(ratios.v2).toFixed(3)}`);
});

test("ISS cues tile a lyric line contiguously", { skip: !have }, () => {
  // Why the painted cells are left standing: cue runs abut each other rather
  // than scattering, so together they wipe the line (FILE_FORMATS §4.2).
  const root = MEGA;
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

test("an .ims ends at totalTick, or at FC if that comes first", { skip: !have }, () => {
  // FILE_FORMATS §1.5: IMPLAY reads no event once its tick counter reaches
  // totalTick. 316 corpus files carry events past it: 314 whose FC comes
  // later, and two damaged ones with no FC at all. All of it is silence or
  // damage but D-PRODC#.IMS's last half minute (FILE_FORMATS §1.5).
  let cut = 0;
  for (const fn of fs.readdirSync(MEGA)) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(MEGA, fn)));
    if (identify(bytes) !== "ims") continue;
    const song = parseIms(bytes);
    let fc = Infinity;
    for (const ev of imsEvents(song)) if (ev.status === 0xfc) { fc = ev.tick; break; }
    const events = [...imsSequence(song)];
    const end = events.at(-1);
    assert.equal(end.type, END, fn);
    const expected = Math.min(fc, song.totalTick);
    if (Number.isFinite(expected)) assert.equal(end.tick, expected, fn);
    assert.ok(events.every((e) => e.tick <= song.totalTick), fn);
    if (song.totalTick < fc) cut++;
  }
  assert.equal(cut, 316);
});
