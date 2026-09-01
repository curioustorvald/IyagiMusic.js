// End-to-end checks against the reference corpus. Skipped when it is absent,
// so the suite still runs on a clean checkout.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { IyagiMusic, parseIms, parseBnk, parseIss, deltaGcd, identify } from "../src/player.js";

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
