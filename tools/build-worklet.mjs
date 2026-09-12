#!/usr/bin/env node
// Build dist/iyagi-processor.bundle.js: one classic script holding the whole
// library, because an AudioWorkletGlobalScope cannot import modules.
//
// This is the only build step the package has, and it exists for that one
// limitation. Everything else ships as the ES modules it was written as.
// `tools/build-pages.mjs` copies the result into the frontend; npm gets it
// through `prepack`.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Bundle order: every module before the ones that use it. */
export const FILES = [
  "src/johab-symbols.js",
  "src/user-glyphs.js",
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

/** Concatenate FILES with their module syntax stripped. */
export async function buildWorklet() {
  let out = `// GENERATED FILE -- do not edit. Rebuild with: npm run build
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
  return out;
}

/** Where the bundle lives, both for `exports` and for build-pages.mjs. */
export const BUNDLE = path.join(root, "dist/iyagi-processor.bundle.js");

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await buildWorklet();
  await mkdir(path.dirname(BUNDLE), { recursive: true });
  await writeFile(BUNDLE, out);
  console.log(`bundle: ${(out.length / 1024).toFixed(1)} kB from ${FILES.length} modules`
    + ` -> ${path.relative(process.cwd(), BUNDLE)}`);
}
