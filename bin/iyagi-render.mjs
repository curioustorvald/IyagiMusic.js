#!/usr/bin/env node
// Render an .ims or .rol to a 16-bit WAV, for listening and for regression
// checks. The package's one executable; `npx iyagi-render` reaches it without
// a checkout. Usage:  iyagi-render song.ims [bank.bnk] [out.wav] [seconds]
import fs from "node:fs";
import path from "node:path";
import { IyagiMusic } from "../src/player.js";

const [song, bank, out = "out.wav", seconds = "30"] = process.argv.slice(2);
if (!song) {
  console.error("usage: iyagi-render <song.ims|.rol> [bank.bnk] [out.wav] [seconds]");
  process.exit(1);
}
const read = (p) => (p && fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : undefined);
const rate = 48000;
const m = new IyagiMusic({
  song: read(song), bank: read(bank), sampleRate: rate,
});
const pcm = m.renderAll(Number(seconds));
const n = pcm.length;
const buf = Buffer.alloc(44 + n * 2);
buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767))), 44 + i * 2);
fs.writeFileSync(out, buf);
console.log(`${path.basename(song)}  "${m.title.trim()}"  ->  ${out}  (${(n / rate).toFixed(1)}s`
  + (m.missing.length ? `, ${m.missing.length} patch(es) missing)` : ")"));
