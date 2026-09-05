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
const BUNDLE = path.resolve(repo, "../github-pages/iyagimusic-worker/iyagi-processor.bundle.js");
const CORPUS = "/home/torvald/Documents/tsvm/reference_materials/Iyagi Music Sound";
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
  // Stereo is the mono chip duplicated, so the channels must match exactly.
  assert.deepEqual([...out[0][0]], [...out[0][1]]);
  assert.ok(scope.__posted.some((m) => m.type === "position" && m.seconds > 0));
});
