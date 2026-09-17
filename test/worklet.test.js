// The worklet bundle is a generated concat with its imports stripped, so a
// missing module shows up only at run time, inside a scope with no console.
// Run it here in a stand-in AudioWorkletGlobalScope and drive a real song
// through it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
// `npm test` rebuilds this first (the `pretest` script), so these two run
// rather than skipping. A bare `node --test` on a tree that has never been
// built still skips.
const BUNDLE = path.resolve(repo, "dist/iyagi-processor.bundle.js");
const CORPUS = "/home/torvald/Documents/tsvm/reference_materials/Iyagi Music Sound";
const MEGA = path.join(CORPUS, "IMS_FILE_MEGA_CORPUS");
const have = fs.existsSync(BUNDLE);

/** Enough of AudioWorkletGlobalScope for the processor to live in. */
function makeScope(rate = 48000) {
  const registered = new Map();
  const scope = {
    sampleRate: rate,
    currentTime: 0,
    Math, Object, Array, Number, String, Symbol, Error, TypeError, JSON, Map, Set,
    Uint8Array, Uint16Array, Int8Array, Int16Array, Int32Array, Float32Array,
    Float64Array, DataView, ArrayBuffer, isNaN, parseInt, parseFloat,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = {
          postMessage: (m) => scope.__posted.push(m),
          onmessage: null,
        };
      }
    },
    registerProcessor: (name, cls) => registered.set(name, cls),
    __posted: [],
    __registered: registered,
  };
  scope.globalThis = scope;
  return scope;
}

test("the worklet bundle registers its processor", { skip: !have }, () => {
  const scope = makeScope();
  vm.createContext(scope);
  vm.runInContext(fs.readFileSync(BUNDLE, "utf8"), scope, { filename: "bundle.js" });
  assert.ok(scope.__registered.has("iyagi-processor"));
});

test("the worklet renders a song", { skip: !have || !fs.existsSync(CORPUS) }, () => {
  const scope = makeScope(48000);
  vm.createContext(scope);
  vm.runInContext(fs.readFileSync(BUNDLE, "utf8"), scope, { filename: "bundle.js" });
  const Processor = scope.__registered.get("iyagi-processor");
  const p = new Processor();

  const read = (f) => new Uint8Array(fs.readFileSync(path.join(CORPUS, f)));
  p.port.onmessage({
    data: {
      type: "load",
      song: read("ZZ-BLCAT.IMS"),
      fallbackBank: read("STANDARD.BNK"),
    },
  });
  const loaded = scope.__posted.find((m) => m.type === "loaded");
  assert.ok(loaded, `no 'loaded' message; got ${JSON.stringify(scope.__posted)}`);
  assert.equal(loaded.kind, "ims");
  assert.equal(loaded.missing.length, 0, `unresolved: ${[...loaded.missing]}`);

  p.port.onmessage({ data: { type: "play" } });
  const out = [[new Float32Array(128), new Float32Array(128)]];
  let energy = 0;
  for (let block = 0; block < 400; block++) {
    scope.currentTime += 128 / 48000;
    assert.equal(p.process([], out), true);
    for (const v of out[0][0]) energy += v * v;
  }
  assert.ok(energy > 1, `worklet produced silence (energy ${energy})`);
  // An .ims plays on a YM3812, which has one output, so the two channels must
  // match exactly.
  assert.deepEqual([...out[0][0]], [...out[0][1]]);
  assert.ok(scope.__posted.some((m) => m.type === "position" && m.seconds > 0));
  const position = scope.__posted.find((m) => m.type === "position");
  assert.equal(position.voices, 11, "ZZ-BLCAT is a rhythm-mode song: 6 + 5");
});

test("the worklet plays a SOP on the OPL3, in stereo", { skip: !have || !fs.existsSync(MEGA) }, () => {
  // The whole OPL3 path through the bundle: an eighteen-channel chip, twenty
  // meter rows and two different output channels, none of which an .ims
  // exercises.
  const scope = makeScope(48000);
  vm.createContext(scope);
  vm.runInContext(fs.readFileSync(BUNDLE, "utf8"), scope, { filename: "bundle.js" });
  const Processor = scope.__registered.get("iyagi-processor");
  const p = new Processor();

  p.port.onmessage({
    data: {
      type: "load",
      song: new Uint8Array(fs.readFileSync(path.join(MEGA, "4OPDANCE.SOP"))),
    },
  });
  const loaded = scope.__posted.find((m) => m.type === "loaded");
  assert.ok(loaded, `no 'loaded' message; got ${JSON.stringify(scope.__posted.map((m) => m.type))}`);
  assert.equal(loaded.kind, "sop");
  assert.equal(loaded.chip, "opl3");

  p.port.onmessage({ data: { type: "play" } });
  const out = [[new Float32Array(128), new Float32Array(128)]];
  let energy = 0, spread = 0;
  for (let block = 0; block < 1200; block++) {
    scope.currentTime += 128 / 48000;
    assert.equal(p.process([], out), true);
    for (let i = 0; i < 128; i++) {
      energy += out[0][0][i] * out[0][0][i];
      spread += Math.abs(out[0][0][i] - out[0][1][i]);
    }
  }
  assert.ok(energy > 1, `worklet produced silence (energy ${energy})`);
  assert.ok(spread > 1, "the two channels were identical: panning never reached the output");

  const position = scope.__posted.find((m) => m.type === "position");
  assert.equal(position.voices, 20, "a percussive SOP on an OPL3 has 15 + 5 voices");
  assert.ok(position.meter.length >= 20 * 8, "the meter buffer is too small for twenty rows");
  assert.ok(position.patchNames.length >= 20, "patch names must cover every voice");
});
