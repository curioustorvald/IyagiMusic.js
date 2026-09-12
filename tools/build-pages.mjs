#!/usr/bin/env node
// Publish the library into the frontend's tree.
//
// Two artefacts, because a page needs the modules two different ways:
//   iyagimusic-worker/lib/**                 plain ES modules for the main thread
//   iyagimusic-worker/iyagi-processor.bundle.js
//                                            one classic script, because an
//                                            AudioWorklet cannot import modules
//
// The bundle itself is built by tools/build-worklet.mjs, which is also what
// `npm run build` and `prepack` call -- the frontend and the npm tarball get
// the same bytes. This script only copies.

import { writeFile, mkdir, readdir, cp, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildWorklet } from "./build-worklet.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
// The Cloudflare Pages project directory inside the IyagiMusic-web checkout,
// which is what the browser loads. Overridable, because the sibling clone is
// not guaranteed to sit where this assumes.
const pages = path.resolve(root,
  process.env.IYAGI_PAGES_DIR ?? "../iyagimusic-web/iyagimusic-worker");

try {
  await access(path.join(pages, "index.html"));
} catch {
  console.error(`no frontend at ${pages}`);
  console.error("clone IyagiMusic-web beside this repo, or set IYAGI_PAGES_DIR.");
  process.exit(1);
}

const out = await buildWorklet();
await mkdir(pages, { recursive: true });
await writeFile(path.join(pages, "iyagi-processor.bundle.js"), out);

await cp(path.join(root, "src"), path.join(pages, "lib"), { recursive: true });

const count = (await readdir(path.join(pages, "lib"), { recursive: true }))
  .filter((f) => f.endsWith(".js")).length;
console.log(`bundle: ${(out.length / 1024).toFixed(1)} kB`);
console.log(`lib/:   ${count} modules copied to ${path.relative(process.cwd(), pages)}`);
