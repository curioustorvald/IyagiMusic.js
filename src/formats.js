// Readers for the four Iyagi/AdLib file types.  Pure data in, plain objects
// out -- no audio, no DOM.  See docs/FILE_FORMATS.en.md; section numbers in
// the comments below refer to it.

import { decodeJohabField } from "./johab2unicode.js";

/** @typedef {import("./johab2unicode.js").DecodeOptions} DecodeOptions */
/** Anything the readers will take: the bytes of a file. @typedef {Uint8Array|ArrayBufferView|ArrayBuffer} Bytes */

const IMS_HEADER_SIZE = 70;
const BNK_NAME_RECORD_SIZE = 12;
const BNK_PATCH_RECORD_SIZE = 30;
const ISS_HEADER_SIZE = 154;
const ISS_RECORD_SIZE = 5;
const ISS_LINE_SIZE = 64;
const SOP_HEADER_SIZE = 76;
/** SOP §3.1: instType byte, then char[8] shortName and char[19] longName. */
const SOP_INST_NAME_SIZE = 28;
/**
 * SOP §3.1: packed register bytes per instType. These are exactly the types
 * NOTE.EXE's own reader and writer have a size for; type 2 is on the list
 * although no corpus file uses it, because the editor round-trips it. Anything
 * else is a parse error -- Note itself would read no data bytes for it and
 * lose its place in the file.
 */
const SOP_INST_DATA_SIZE = { 0: 22, 1: 11, 2: 11, 6: 11, 7: 11, 8: 11, 9: 11, 10: 11, 12: 0 };
/** SOP §4.2: value bytes following the event code, in a sequenced track. */
const SOP_TRACK_VALUE_SIZE = { 1: 1, 2: 3, 4: 1, 5: 1, 6: 1, 7: 1 };
/** SOP §5: the control track has its own, disjoint, code space. */
const SOP_CTRL_VALUE_SIZE = { 3: 1, 8: 1 };

export class FormatError extends Error {}

/* ---------------------------------------------------------------- shapes */
// The readers return plain objects, and these say what is in them. Field for
// field they are the file, not a model of it: where the format has a number
// the object has that number, and §-references in the comments above each
// reader point at the bytes it came from.

/**
 * One FM operator's parameters, straight out of a BNK patch record. §2.3.
 * @typedef {object} Operator
 * @property {number} ksl @property {number} multiple @property {number} feedback
 * @property {number} attack @property {number} sustain @property {number} eg
 * @property {number} decay @property {number} release @property {number} totalLevel
 * @property {number} am @property {number} vib @property {number} ksr
 * @property {number} connection
 */

/**
 * A named instrument: two operators and their waveform selects. §2.3.
 *
 * `pair` is the second half of a four-operator instrument, and only a `.sop`
 * type-0 instrument has one (SOP §3.3). It is an ordinary Patch itself -- the
 * same eleven bytes read the same way -- so a caller that knows nothing about
 * four-operator voices reads the first pair and is right about it. The driver
 * loads the second pair where the chip has somewhere to put it, and ignores it
 * where it does not.
 *
 * @typedef {object} Patch
 * @property {string} name
 * @property {Operator} modulator
 * @property {Operator} carrier
 * @property {number} modWave
 * @property {number} carWave
 * @property {Patch} [pair] operators 3 and 4, for a four-operator instrument
 */

/**
 * An AdLib instrument bank. §2.
 * @typedef {object} Bank
 * @property {number[]} version major and minor
 * @property {number} used @property {number} count
 * @property {number} offsetName @property {number} offsetData
 * @property {Patch[]} patches in name-record order
 * @property {Map<string, Patch>} byName keyed by upper-case name; §1.6
 */

/**
 * An IMS song. The event stream is left as raw bytes -- walk it with
 * `imsEvents`. §1.
 * @typedef {object} ImsSong
 * @property {number[]} version
 * @property {string} title already Johab-decoded
 * @property {number} tickBeat @property {number} beatMeasure
 * @property {number} totalTick advisory; §1.5 -- FC is what ends the song
 * @property {number} commandCount
 * @property {number} srcTickBeat the source ROL's tickBeat, or 0; §1.8
 * @property {boolean} percussive
 * @property {number} pitchRange semitones, clamped to 1..12
 * @property {number} tempo
 * @property {Uint8Array} events
 * @property {string[]} patchNames one per voice slot; resolve with `resolvePatches`
 */

/**
 * One event off an IMS stream. `status` is the full status byte; `a` and `b`
 * are the data bytes it actually uses.
 * @typedef {object} ImsEvent
 * @property {number} tick absolute, in ticks
 * @property {number} delay ticks since the previous event
 * @property {number} status
 * @property {number} a @property {number} b
 */

/** @typedef {{tick: number, multiplier: number}} RolTempoEvent */
/** @typedef {{tick: number, note: number, duration: number}} RolNote */
/** @typedef {{tick: number, name: string, unknown: number}} RolTimbre */
/** @typedef {{tick: number, volume: number}} RolVolume */
/** @typedef {{tick: number, pitch: number}} RolPitch */

/**
 * One of a ROL's eleven voices. §3.
 * @typedef {object} RolVoice
 * @property {string} name
 * @property {RolNote[]} notes
 * @property {RolTimbre[]} timbres
 * @property {RolVolume[]} volumes
 * @property {RolPitch[]} pitches
 * @property {number} [tickCount]
 * @property {string} [timbreName] @property {string} [volumeName] @property {string} [pitchName]
 */

/**
 * An AdLib Visual Composer song. §3.
 * @typedef {object} RolSong
 * @property {number[]} version
 * @property {string} title free text in practice; Korean files put Johab here
 * @property {number} tickBeat @property {number} beatMeasure
 * @property {number} scaleY @property {number} scaleX
 * @property {boolean} percussive isMelodic is INVERTED versus IMS; §1.1
 * @property {number[]|null} counters
 * @property {RolVoice[]} voices always eleven
 * @property {{name: string, tempo: number, events: RolTempoEvent[]}} [tempoTrack]
 * @property {number} [bytesRead]
 */

/**
 * One lyric cue: the right edge of a highlight, not an isolated run. §4.2.
 * @typedef {object} IssCue
 * @property {number} tick already multiplied back up by 8
 * @property {number} line @property {number} startX @property {number} widthX
 */

/**
 * Timed lyrics. §4.
 * @typedef {object} Iss
 * @property {string} signature
 * @property {string} writer @property {string} composer
 * @property {string} singer @property {string} editor
 * @property {string[]} lines 64-cell text lines, Johab-decoded
 * @property {IssCue[]} cues sorted by tick
 */

/** A resolved highlight, in character cells. @typedef {{line: number, from: number, to: number}} IssSpan */

/**
 * One entry of a SOP's instrument table. `data` is left packed -- these are
 * OPL register bytes, where a BNK carries thirteen unpacked parameters per
 * operator -- so `sopPatch` is what turns one into something the driver takes.
 * SOP §3.1.
 * @typedef {object} SopInstrument
 * @property {number} type 0 four-op, 1 two-op melody, 6..10 rhythm, 12 comment
 * @property {string} shortName bank instrument name; `char[8]`, often unterminated
 * @property {string} longName display name -- or, for type 12, the comment line
 * @property {Uint8Array} data 22, 11 or 0 packed register bytes
 */

/**
 * One event, off a sequenced track or off the control track. SOP §4.2, §5.
 * @typedef {object} SopEvent
 * @property {number} tick absolute, in ticks
 * @property {number} delta ticks since the previous event on the same track
 * @property {number} code
 * @property {number} value
 * @property {number} [length] note-on only, in ticks
 */

/**
 * One of a SOP's twenty tracks. SOP §4.1.
 * @typedef {object} SopTrack
 * @property {number} mode channel mode, masked to 0..2; SOP §2
 * @property {number} modeRaw the byte as stored -- bit 7 is undocumented, SOP §2
 * @property {SopEvent[]} events
 */

/**
 * A SOP song -- the format the "Note" editor wrote, magic `sopepos`. SOP §1.
 * @typedef {object} SopSong
 * @property {number[]} version major and minor; only 0.1 exists
 * @property {string} fileName what it was saved as, which is not always its own name
 * @property {string} title already Johab-decoded
 * @property {boolean} percussive
 * @property {number} tickBeat @property {number} beatMeasure @property {number} basicTempo
 * @property {SopInstrument[]} instruments
 * @property {SopTrack[]} tracks always twenty; SOP §1
 * @property {SopEvent[]} control tempo and global volume only; SOP §5
 * @property {string[]} comments the type-12 instruments' text, in file order; SOP §6
 */


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

/**
 * Parse an AdLib instrument bank.  §2.
 * @param {Bytes} data
 * @returns {Bank}
 */
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

/** @returns {Operator} */
function readOperator(b, o) {
  const op = {};
  for (let i = 0; i < OPERATOR_FIELDS.length; i++) op[OPERATOR_FIELDS[i]] = b[o + i];
  return op;
}

/** One 30-byte patch record.  §2.3.  @returns {Patch} */
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

/**
 * Parse an IMS song.  §1.  The event stream is left as raw bytes.
 * @param {Bytes} data
 * @param {DecodeOptions} [options] how to read the Johab title
 * @returns {ImsSong}
 */
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
 * @param {ImsSong} song
 * @param {...(Bank|null|undefined)} banks
 * @returns {(Patch|null)[]}
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

/**
 * Delta-time GCD, which recovers the composer's row grid.  §1.8.
 * @param {ImsSong} song
 * @returns {number}
 */
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
 * @param {ImsSong} song
 * @returns {Generator<ImsEvent, void, undefined>}
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

/**
 * Parse an AdLib Visual Composer song.  §3.
 * @param {Bytes} data
 * @param {DecodeOptions} [options]
 * @returns {RolSong}
 */
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

/**
 * Parse timed lyrics.  §4.  Returns null for anything that is not an ISS.
 * @param {Bytes} data
 * @param {DecodeOptions} [options]
 * @returns {Iss|null}
 */
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
 *
 * @param {Iss} iss
 * @returns {IssSpan[]}
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

/* ------------------------------------------------------------------ SOP */

/**
 * Parse a SOP song. SOP §1.
 *
 * Everything after the 76-byte header is positional -- channel modes, then
 * instruments, then twenty tracks, then the control track, with no offsets
 * anywhere -- so this has to be read strictly in order, the way a ROL does.
 * The upside is that the file has to end exactly where the control track does,
 * which is a strong check that nothing was misread: all 336 corpus files land
 * on the last byte.
 *
 * @param {Bytes} data
 * @param {DecodeOptions} [options] how to read the Johab title
 * @returns {SopSong}
 */
export function parseSop(data, options) {
  const b = asBytes(data);
  if (b.length < SOP_HEADER_SIZE) throw new FormatError("SOP too short");
  if (String.fromCharCode(...b.subarray(0, 7)) !== "sopepos") {
    throw new FormatError("not a SOP file (bad signature)");
  }
  const dv = view(b);
  const nTracks = b[73];
  const song = {
    version: [b[7], b[8]],
    fileName: text(b, 10, 13, options),
    title: text(b, 23, 31, options),
    percussive: b[54] !== 0,
    tickBeat: b[56],
    beatMeasure: b[58],
    basicTempo: b[59],
    // Bytes 61..72 are never written by the editor; SOP §1 -- they are
    // whatever its uncleared header buffer held, inherited from the last SOP
    // it loaded, so they are not exposed. Byte 60 is basicTempo's high byte.
    instruments: [],
    tracks: [],
    control: [],
    comments: [],
  };

  let o = SOP_HEADER_SIZE;
  const modes = b.subarray(o, o + nTracks);
  o += nTracks;
  if (o > b.length) throw new FormatError("SOP channel-mode table truncated");

  for (let i = 0; i < b[74]; i++) {
    if (o + SOP_INST_NAME_SIZE > b.length) throw new FormatError("SOP instrument truncated");
    const type = b[o];
    const size = SOP_INST_DATA_SIZE[type];
    if (size === undefined) {
      throw new FormatError(`SOP instrument ${i}: unknown instType ${type}`);
    }
    const inst = {
      type,
      shortName: text(b, o + 1, 8, options),
      longName: text(b, o + 9, 19, options),
      data: b.subarray(o + SOP_INST_NAME_SIZE, o + SOP_INST_NAME_SIZE + size),
    };
    // §6: type 12 is not an instrument at all -- it is one 19-column line of
    // the song's scrolling credits, parked in the instrument table so that the
    // editor had somewhere to keep it.
    if (type === 12) song.comments.push(inst.longName);
    song.instruments.push(inst);
    o += SOP_INST_NAME_SIZE + size;
  }

  /** §4.1 and §5 share a layout: u16 event count, u32 byte count, then events. */
  const readTrack = (sizes, what) => {
    if (o + 6 > b.length) throw new FormatError(`SOP ${what} header truncated`);
    const count = dv.getUint16(o, true);
    const size = dv.getUint32(o + 2, true);
    o += 6;
    const end = o + size;
    if (end > b.length) throw new FormatError(`SOP ${what} runs past the end of the file`);
    const events = [];
    let tick = 0;
    while (o < end) {
      const delta = dv.getUint16(o, true);
      const code = b[o + 2];
      const valueSize = sizes[code];
      if (valueSize === undefined) throw new FormatError(`SOP ${what}: unknown event ${code}`);
      tick += delta;
      const ev = { tick, delta, code, value: b[o + 3] };
      // §4.2: only the note-on carries more than one value byte.
      if (code === 2) ev.length = dv.getUint16(o + 4, true);
      events.push(ev);
      o += 3 + valueSize;
    }
    // Both counts are redundant with the walk, which is exactly why they are
    // worth checking: either one disagreeing means the events were misread.
    if (o !== end) throw new FormatError(`SOP ${what}: events overran dataSize`);
    if (events.length !== count) {
      throw new FormatError(`SOP ${what}: numEvents says ${count}, walked ${events.length}`);
    }
    return events;
  };

  for (let t = 0; t < nTracks; t++) {
    song.tracks.push({
      mode: modes[t] & 0x7f,      // §2: bit 7 is the editor's channel-disable switch, view state
      modeRaw: modes[t],
      events: readTrack(SOP_TRACK_VALUE_SIZE, `track ${t}`),
    });
  }
  song.control = readTrack(SOP_CTRL_VALUE_SIZE, "control track");
  return song;
}

/** Unpack one operator's five register bytes into a bank operator. SOP §3.2. */
function sopOperator(char, scale, attackDecay, sustainRelease, feedback) {
  return {
    ksl: (scale >> 6) & 3,
    multiple: char & 0x0f,
    feedback: (feedback >> 1) & 7,
    attack: (attackDecay >> 4) & 0x0f,
    sustain: (sustainRelease >> 4) & 0x0f,
    eg: (char >> 5) & 1,
    decay: attackDecay & 0x0f,
    release: sustainRelease & 0x0f,
    totalLevel: scale & 0x3f,
    am: (char >> 7) & 1,
    vib: (char >> 6) & 1,
    ksr: (char >> 4) & 1,
    // A bank's `connection` is the 0xC0 bit read the other way up: the driver
    // writes `connection ? 0 : 1`, so an additive patch stores 0 here.
    connection: feedback & 1 ? 0 : 1,
  };
}

/**
 * One eleven-byte operator pair, as a Patch. SOP §3.2.
 *
 * `singleOp` is the rhythm-voice reading: types 7..10 are one operator, and
 * bytes 6..10 are never used for them, so the carrier is zeroed. Byte 5 is
 * kept: NOTE.EXE writes its low nibble to 0xC7 on the hi-hat track and 0xC8 on
 * the tom track (SOP §3.2), and the operator fields below read only those four
 * bits of it. The driver writes 0xC0 for exactly those two drums, because they
 * are the modulator slots of their channels.
 */
function sopPair(name, d, at, singleOp) {
  const feedback = d[at + 5];
  return {
    name,
    modulator: sopOperator(d[at], d[at + 1], d[at + 2], d[at + 3], feedback),
    carrier: singleOp
      ? sopOperator(0, 0, 0, 0, 0)
      : sopOperator(d[at + 6], d[at + 7], d[at + 8], d[at + 9], feedback),
    // Wave selects 4..7 are the OPL3's. They pass through as the file stores
    // them; the driver masks them to what its chip can actually reach.
    modWave: d[at + 4],
    carWave: singleOp ? 0 : d[at + 10],
  };
}

/**
 * Turn a SOP instrument into the shape a BNK patch has, so that the driver can
 * load it. Returns null for a comment (type 12) and for anything whose data
 * the file cut short.
 *
 * A four-operator instrument (type 0) is two of these back to back, and comes
 * back as a patch carrying its second pair in `pair`. What happens to that pair
 * is the chip's business rather than the format's: a YMF262 joins two channels
 * and plays all four operators, and a YM3812 has no fourth-operator register to
 * put them in and plays the first pair alone. SOP §8.
 *
 * @param {SopInstrument} inst
 * @returns {Patch|null}
 */
export function sopPatch(inst) {
  const d = inst.data;
  if (inst.type === 12 || d.length < 11) return null;
  const singleOp = inst.type >= 7 && inst.type <= 10;
  const patch = sopPair(inst.shortName, d, 0, singleOp);
  // §3.3: the second pair sits at register offsets 0x08/0x0B with its own
  // feedback byte, which is the same eleven-byte layout eleven bytes along.
  if (inst.type === 0 && d.length >= 22) patch.pair = sopPair(inst.shortName, d, 11, false);
  return patch;
}

/**
 * Sniff a dropped file by content, since extensions are not always right.
 * @param {Bytes} data
 * @returns {"ims"|"rol"|"bnk"|"iss"|"sop"|null}
 */
export function identify(data) {
  const b = asBytes(data);
  if (b.length >= 8 && String.fromCharCode(...b.subarray(2, 8)) === "ADLIB-") return "bnk";
  // SOP first: its magic is seven bytes of ASCII, so nothing else can collide.
  if (b.length >= SOP_HEADER_SIZE && String.fromCharCode(...b.subarray(0, 7)) === "sopepos") {
    return "sop";
  }
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
