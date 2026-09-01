// Readers for the four Iyagi/AdLib file types.  Pure data in, plain objects
// out -- no audio, no DOM.  See docs/FILE_FORMATS.en.md; section numbers in
// the comments below refer to it.

import { decodeJohabField } from "./johab2unicode.js";

const IMS_HEADER_SIZE = 70;
const BNK_NAME_RECORD_SIZE = 12;
const BNK_PATCH_RECORD_SIZE = 30;
const ISS_HEADER_SIZE = 154;
const ISS_RECORD_SIZE = 5;
const ISS_LINE_SIZE = 64;

export class FormatError extends Error {}

const asBytes = (d) =>
  d instanceof Uint8Array ? d : new Uint8Array(d.buffer ?? d, d.byteOffset ?? 0, d.byteLength ?? d.length);

const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Text up to the first NUL, Johab-decoded.  §"Implementations" of the encoding doc. */
function text(bytes, from, len, options) {
  let end = from;
  const limit = from + len;
  while (end < limit && bytes[end] !== 0) end++;
  return decodeJohabField(bytes.subarray(from, end), options);
}

/* ------------------------------------------------------------------ BNK */

/** Parse an AdLib instrument bank.  §2. */
export function parseBnk(data) {
  const b = asBytes(data);
  if (b.length < 20) throw new FormatError("BNK too short");
  if (String.fromCharCode(...b.subarray(2, 8)) !== "ADLIB-") {
    throw new FormatError("not a BNK file (bad signature)");
  }
  const dv = view(b);
  const bank = {
    version: [b[0], b[1]],
    used: dv.getUint16(8, true),
    count: dv.getUint16(10, true),
    // §2.1: never assume a fixed header size -- five corpus banks have no pad.
    offsetName: dv.getUint32(12, true),
    offsetData: dv.getUint32(16, true),
    patches: [],
    byName: new Map(),
  };
  for (let i = 0; i < bank.count; i++) {
    const o = bank.offsetName + i * BNK_NAME_RECORD_SIZE;
    if (o + BNK_NAME_RECORD_SIZE > b.length) break;
    const index = dv.getUint16(o, true);
    const flags = b[o + 2];
    let end = o + 3;
    while (end < o + 12 && b[end] !== 0) end++;
    const name = String.fromCharCode(...b.subarray(o + 3, end));
    if (!flags || !name) continue;            // §2.2: any non-zero flag is "in use"
    const po = bank.offsetData + index * BNK_PATCH_RECORD_SIZE;
    if (po + BNK_PATCH_RECORD_SIZE > b.length) continue;
    const patch = readPatch(b, po, name);
    bank.patches.push(patch);
    // §1.6: lookup is case-insensitive.  First writer wins, matching a
    // linear scan of the name records.
    const key = name.toUpperCase();
    if (!bank.byName.has(key)) bank.byName.set(key, patch);
  }
  return bank;
}

const OPERATOR_FIELDS = [
  "ksl", "multiple", "feedback", "attack", "sustain", "eg",
  "decay", "release", "totalLevel", "am", "vib", "ksr", "connection",
];

function readOperator(b, o) {
  const op = {};
  for (let i = 0; i < OPERATOR_FIELDS.length; i++) op[OPERATOR_FIELDS[i]] = b[o + i];
  return op;
}

/** One 30-byte patch record.  §2.3. */
function readPatch(b, o, name) {
  return {
    name,
    // iPercussive / iVoiceNum at o+0, o+1 are deliberately not exposed: §2.3
    // says they are unusable, and melodic-vs-percussive is decided by channel.
    modulator: readOperator(b, o + 2),
    carrier: readOperator(b, o + 15),
    modWave: b[o + 28],
    carWave: b[o + 29],
  };
}

/* ------------------------------------------------------------------ IMS */

/** Parse an IMS song.  §1.  The event stream is left as raw bytes. */
export function parseIms(data, options) {
  const b = asBytes(data);
  if (b.length < IMS_HEADER_SIZE) throw new FormatError("IMS too short");
  const dv = view(b);
  const dataSize = dv.getInt32(42, true);
  const end = IMS_HEADER_SIZE + dataSize;
  if (dataSize < 0 || end + 4 > b.length) throw new FormatError("IMS data size out of range");

  const song = {
    version: [b[0], b[1]],
    title: text(b, 6, 30, options),
    tickBeat: b[36],
    beatMeasure: b[37],
    totalTick: dv.getInt32(38, true),   // §1.5: advisory, FC is what ends the song
    commandCount: dv.getInt32(46, true),
    srcTickBeat: b[50],                 // §1.8: the source ROL's tickBeat, or 0
    percussive: b[58] !== 0,
    pitchRange: Math.min(12, Math.max(1, b[59])),
    tempo: dv.getUint16(60, true),
    events: b.subarray(IMS_HEADER_SIZE, end),
    patchNames: [],
  };
  if (b[end] !== 0x77 || b[end + 1] !== 0x77) {
    throw new FormatError("IMS patch table missing (no 'ww' signature)");
  }
  const n = dv.getUint16(end + 2, true);
  for (let i = 0; i < n; i++) {
    const o = end + 4 + i * 9;
    if (o + 9 > b.length) break;
    let stop = o;
    while (stop < o + 9 && b[stop] !== 0) stop++;
    song.patchNames.push(String.fromCharCode(...b.subarray(o, stop)));
  }
  return song;
}

/**
 * Resolve an IMS song's patch names against banks, most specific first.
 * Returns one entry per name, null where nothing matched.  §1.6.
 */
export function resolvePatches(song, ...banks) {
  return song.patchNames.map((name) => {
    const key = name.toUpperCase();
    for (const bank of banks) {
      const hit = bank?.byName.get(key);
      if (hit) return hit;
    }
    return null;
  });
}

/** Delta-time GCD, which recovers the composer's row grid.  §1.8. */
export function deltaGcd(song) {
  let g = 0;
  for (const ev of imsEvents(song)) {
    if (ev.delay) g = gcd(g, ev.delay);
  }
  return g;
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/**
 * Walk an IMS event stream.  Yields {tick, delay, status, a, b} per event;
 * `status` is the full status byte, `a`/`b` the data bytes it actually uses.
 * Tempo events yield {status: 0xF0, a: integer, b: fraction}.
 */
export function* imsEvents(song) {
  const d = song.events;
  let i = 0;
  let running = 0;
  let tick = 0;
  while (i < d.length) {
    let delay = 0;
    let byte = d[i++];
    while (byte === 0xf8) {              // §1.3
      delay += 240;
      if (i >= d.length) return;
      byte = d[i++];
    }
    delay += byte;
    tick += delay;
    if (i >= d.length) return;

    let status = d[i];
    if (status & 0x80) {
      i++;
      // §1.2: F0/FC leave running status undetermined, so we neither set nor
      // trust it across them -- the corpus never relies on either reading.
      if (status < 0xf0) running = status;
    } else {
      status = running;
      if (!status) return;
    }

    if (status === 0xfc) { yield { tick, delay, status, a: 0, b: 0 }; return; }
    if (status === 0xf0) {
      const start = i;
      while (i < d.length && d[i] !== 0xf7) i++;
      const body = d.subarray(start, i);
      i++;                                                  // consume the F7
      if (body.length === 4 && body[0] === 0x7f && body[1] === 0x00) {
        yield { tick, delay, status, a: body[2], b: body[3] };
      }
      continue;
    }
    const high = status & 0xf0;
    const wide = high === 0x80 || high === 0x90 || high === 0xb0 || high === 0xe0;
    const a = d[i++];
    const b = wide ? d[i++] : 0;
    yield { tick, delay, status, a, b };
  }
}

/* ------------------------------------------------------------------ ROL */

/** Parse an AdLib Visual Composer song.  §3. */
export function parseRol(data, options) {
  const b = asBytes(data);
  if (b.length < 182) throw new FormatError("ROL too short");
  const dv = view(b);
  let o = 0;
  const u16 = () => { const v = dv.getUint16(o, true); o += 2; return v; };
  const f32 = () => { const v = dv.getFloat32(o, true); o += 4; return v; };

  const song = {
    version: [u16(), u16()],
    // §3.2: free text in practice -- Korean scene files put a Johab title here.
    title: text(b, (o += 40) - 40, 40, options),
    tickBeat: u16(),
    beatMeasure: u16(),
    scaleY: u16(),
    scaleX: u16(),
    percussive: (o++, b[o++] === 0),      // isMelodic is INVERTED vs IMS §1.1
    counters: null,
    voices: [],
  };
  song.counters = Array.from({ length: 45 }, u16);
  o += 38;

  const name = () => { const v = text(b, o, 15, options); o += 15; return v; };
  song.tempoTrack = { name: name(), tempo: f32(), events: [] };
  for (let n = u16(), i = 0; i < n; i++) {
    song.tempoTrack.events.push({ tick: u16(), multiplier: f32() });
  }

  for (let v = 0; v < 11; v++) {
    const voice = { name: name(), notes: [], timbres: [], volumes: [], pitches: [] };
    const ticks = u16();
    for (let t = 0; t < ticks;) {
      const note = u16();
      const duration = u16();
      voice.notes.push({ tick: t, note, duration });
      if (duration <= 0) break;                     // malformed; do not spin
      t += duration;
    }
    voice.tickCount = ticks;
    voice.timbreName = name();
    for (let n = u16(), i = 0; i < n; i++) {
      const tick = u16();
      const instName = text(b, o, 9, options);
      o += 10;                                      // char[9] + filler byte
      voice.timbres.push({ tick, name: instName, unknown: u16() });
    }
    voice.volumeName = name();
    for (let n = u16(), i = 0; i < n; i++) {
      voice.volumes.push({ tick: u16(), volume: f32() });
    }
    voice.pitchName = name();
    for (let n = u16(), i = 0; i < n; i++) {
      voice.pitches.push({ tick: u16(), pitch: f32() });
    }
    song.voices.push(voice);
  }
  song.bytesRead = o;
  return song;
}

/* ------------------------------------------------------------------ ISS */

/** Parse timed lyrics.  §4.  Returns null for anything that is not an ISS. */
export function parseIss(data, options) {
  const b = asBytes(data);
  if (b.length < ISS_HEADER_SIZE) return null;
  const dv = view(b);
  const recCount = dv.getUint16(150, true);
  const lineCount = dv.getUint16(152, true);
  if (ISS_HEADER_SIZE + ISS_RECORD_SIZE * recCount + ISS_LINE_SIZE * lineCount > b.length) {
    return null;
  }
  const iss = {
    signature: text(b, 0, 20, options),
    writer: text(b, 30, 30, options),
    composer: text(b, 60, 30, options),
    singer: text(b, 90, 30, options),
    editor: text(b, 120, 30, options),
    lines: [],
    cues: [],
  };
  for (let i = 0; i < recCount; i++) {
    const o = ISS_HEADER_SIZE + i * ISS_RECORD_SIZE;
    iss.cues.push({
      tick: dv.getUint16(o, true) * 8,   // §4.2: stored divided by 8
      line: b[o + 2],                    // all three are UNSIGNED
      startX: b[o + 3],
      widthX: b[o + 4],
    });
  }
  const lineBase = ISS_HEADER_SIZE + recCount * ISS_RECORD_SIZE;
  for (let i = 0; i < lineCount; i++) {
    iss.lines.push(text(b, lineBase + i * ISS_LINE_SIZE, ISS_LINE_SIZE, options));
  }
  iss.cues.sort((x, y) => x.tick - y.tick);   // §4.2: 90 of 680 files need this
  return iss;
}

/**
 * Resolve each ISS cue into the span of cells that should be coloured when it
 * is current. Returns an array parallel to `iss.cues`, each `{line, from, to}`
 * in character cells.
 *
 * A cue is not the highlight -- it is the *right edge* of it. The coloured
 * region runs from the leftmost column the line has reached so far up to
 * `startX + widthX`, and moving to another line starts over. Reading each cue
 * as its own isolated run instead lights one syllable at a time, which is not
 * what these files describe.
 *
 * On an ordinary lyric line the cues tile the text left to right -- the gap
 * between one cue's end and the next cue's start is 0 in 168 527 corpus cases
 * and 1 (a space) in 75 582 -- so the region grows a syllable at a time and
 * the effect is the familiar karaoke wipe. The idiom also gets used for
 * animation: a banner line whose right edge runs out and back reads as a
 * volume meter, and 168 corpus lines carry more than sixty cues doing exactly
 * that.
 */
export function resolveIssSpans(iss) {
  const out = [];
  let line = -1;
  let origin = 0;
  for (const cue of iss.cues) {
    if (cue.line !== line) { line = cue.line; origin = cue.startX; }
    else if (cue.startX < origin) origin = cue.startX;
    out.push({ line, from: origin, to: cue.startX + cue.widthX });
  }
  return out;
}

/** Sniff a dropped file by content, since extensions are not always right. */
export function identify(data) {
  const b = asBytes(data);
  if (b.length >= 8 && String.fromCharCode(...b.subarray(2, 8)) === "ADLIB-") return "bnk";
  if (b.length >= 3 && b[0] === 0x49 && b[1] === 0x4d && b[2] === 0x50) return "iss";
  if (b.length >= IMS_HEADER_SIZE && b[0] === 1 && b[1] === 0) {
    const ds = view(b).getInt32(42, true);
    const end = IMS_HEADER_SIZE + ds;
    if (ds > 0 && end + 4 <= b.length && b[end] === 0x77 && b[end + 1] === 0x77) return "ims";
  }
  if (b.length >= 182 && view(b).getUint16(0, true) === 0 && view(b).getUint16(2, true) === 4) {
    return "rol";
  }
  return null;
}
