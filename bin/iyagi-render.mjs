#!/usr/bin/env node
// Render an .ims, .rol or .sop to a 16-bit WAV, for listening and for regression
// checks. The package's one executable; `npx iyagi-render` reaches it without
// a checkout. Usage:  iyagi-render song.ims [bank.bnk] [out.wav] [seconds]
// A .sop embeds its own instruments, so pass "" where the bank would go.
//
// Two options reach a version-0.2 SOP's sample voices, whose rules were
// settled by ear and by judgement rather than read from anything (SOP §10.6):
//   --sample-ref=N   note N plays a sample at its recorded rate; 24 unless
//                    given. --sample-ref=native plays every note at it
//   --sample-ring    let a sample play to its own end; by default it stops
//                    when its note does (--sample-cut says so explicitly)
//
// The WAV is stereo when the chip is -- a .sop plays on a YMF262 and can pan
// (SOP §4.2) -- and mono otherwise, because writing the same samples twice
// would double the file for nothing.
import fs from "node:fs";
import path from "node:path";
import { IyagiMusic } from "../src/player.js";

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const [song, bank, out = "out.wav", seconds = "30"] = args.filter((a) => !a.startsWith("--"));
const USAGE = "usage: iyagi-render <song.ims|.rol|.sop> [bank.bnk] [out.wav] [seconds]"
  + " [--sample-ref=N|native] [--sample-cut|--sample-ring]";
/** @type {number|null|undefined} undefined leaves the format's own default */
let sampleReference;
/** @type {boolean|undefined} likewise */
let sampleCut;
for (const f of flags) {
  const ref = /^--sample-ref=(native|-?\d+)$/.exec(f);
  if (ref) sampleReference = ref[1] === "native" ? null : Number(ref[1]);
  else if (f === "--sample-cut") sampleCut = true;
  else if (f === "--sample-ring") sampleCut = false;
  else { console.error(`unknown option ${f}\n${USAGE}`); process.exit(1); }
}
if (!song) {
  console.error(USAGE);
  process.exit(1);
}
const read = (p) => (p && fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : undefined);
const rate = 48000;
const m = new IyagiMusic({
  song: read(song), bank: read(bank), sampleRate: rate, sampleReference, sampleCut,
});

const channels = m.stereo ? 2 : 1;
const cap = Math.ceil(Number(seconds) * rate);
const block = 4096;
const left = new Float32Array(block), right = new Float32Array(block);
/** @type {Float32Array[]} interleaved-ready chunks, in order */
const chunks = [];
let frames = 0;
while (frames < cap) {
  const ok = channels === 2
    ? m.renderStereo(left, right, 0, block)
    : m.render(left, 0, block);
  if (!ok) break;
  const take = Math.min(block, cap - frames);
  const chunk = new Float32Array(take * channels);
  for (let i = 0; i < take; i++) {
    chunk[i * channels] = left[i];
    if (channels === 2) chunk[i * channels + 1] = right[i];
  }
  chunks.push(chunk);
  frames += take;
}

const samples = frames * channels;
const bytesPerFrame = channels * 2;
const buf = Buffer.alloc(44 + samples * 2);
buf.write("RIFF", 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write("WAVE", 8);
buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(channels, 22); buf.writeUInt32LE(rate, 24);
buf.writeUInt32LE(rate * bytesPerFrame, 28);
buf.writeUInt16LE(bytesPerFrame, 32); buf.writeUInt16LE(16, 34);
buf.write("data", 36); buf.writeUInt32LE(samples * 2, 40);
let at = 44;
for (const chunk of chunks) {
  for (const v of chunk) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), at);
    at += 2;
  }
}
fs.writeFileSync(out, buf);
console.log(`${path.basename(song)}  "${m.title.trim()}"  ->  ${out}`
  + `  (${(frames / rate).toFixed(1)}s, ${m.chipKind.toUpperCase()},`
  + ` ${channels === 2 ? "stereo" : "mono"}`
  + (m.sampleVoiceCount
    ? `, ${m.sampleVoiceCount} sample voices at ${m.sampleReference === null ? "native rate" : `ref ${m.sampleReference}`}`
      + (m.sampleCut ? ", cut at note end" : ", ringing to sample end")
    : "")
  + (m.missing.length ? `, ${m.missing.length} patch(es) missing)` : ")"));
