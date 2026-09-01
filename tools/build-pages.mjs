#!/usr/bin/env node
// Publish the library into the GitHub Pages tree.
//
// Two artefacts, because a page needs the modules two different ways:
//   github-pages/lib/**            plain ES modules for the main thread
//   github-pages/iyagi-processor.bundle.js
//                                  one classic script, because an
//                                  AudioWorklet cannot import modules
//
// There is no build step for the library itself -- this only copies and
// concatenates. Run it after any change under src/.

import { readFile, writeFile, mkdir, readdir, cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const pages = path.resolve(root, "../github-pages");

/** Bundle order: every module before the ones that use it. */
const FILES = [
  "src/johab-symbols.js",
  "src/johab2unicode.js",
  "src/fnum-table.js",
  "src/opl/constants.js",
  "src/opl/tables.js",
  "src/opl/chip.js",
  "src/formats.js",
  "src/driver.js",
  "src/sequencer.js",
  "src/player.js",
  "src/worklet/processor.js",
];

let out = `// GENERATED FILE -- do not edit. Rebuild with: node tools/build-pages.mjs
// Single-file concat of src/** for AudioWorklets, which cannot import modules.
"use strict";
`;

for (const rel of FILES) {
  let src = await readFile(path.join(root, rel), "utf8");
  src = src.replace(/^import\s[\s\S]*?from\s*"[^"]+";\s*$/gm, "");
  src = src.replace(/^export\s*\{[\s\S]*?\}\s*(from\s*"[^"]+")?;\s*$/gm, "");
  src = src.replace(/^export\s+(function|const|class|let|var|async)/gm, "$1");
  out += `\n// == ${rel} ==\n${src}`;
}

const stray = out.split("\n").find((l) => /^\s*(import|export)\s/.test(l));
if (stray) throw new Error(`unstripped module syntax: ${stray}`);

// Every module the graph imports has to be in FILES: stripping the import
// lines hides an omission until the worklet dies with a ReferenceError, where
// the only diagnostic is silence.
const seen = new Set(FILES.map((f) => path.resolve(root, f)));
for (const rel of FILES) {
  const src = await readFile(path.join(root, rel), "utf8");
  for (const m of src.matchAll(/from\s*"(\.[^"]+)"/g)) {
    const target = path.resolve(path.dirname(path.join(root, rel)), m[1]);
    if (!seen.has(target)) throw new Error(`${rel} imports ${m[1]}, which is not bundled`);
  }
}

await mkdir(pages, { recursive: true });
await writeFile(path.join(pages, "iyagi-processor.bundle.js"), out);

await cp(path.join(root, "src"), path.join(pages, "lib"), { recursive: true });

const count = (await readdir(path.join(pages, "lib"), { recursive: true }))
  .filter((f) => f.endsWith(".js")).length;
console.log(`bundle: ${(out.length / 1024).toFixed(1)} kB from ${FILES.length} modules`);
console.log(`lib/:   ${count} modules copied to ${path.relative(process.cwd(), pages)}`);
