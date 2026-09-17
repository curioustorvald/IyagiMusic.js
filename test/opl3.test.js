// The OPL3 additions, checked against what the chip is documented to do rather
// than against another emulator: the second bank against the first, the four
// new waveforms against their own shapes, the four-operator connections
// against which operators they say reach the output, and the stereo switches
// against what comes out of each bus.
//
// The first test is the load-bearing one. A YMF262 is a YM3812 until register
// 0x105 says otherwise, so an OPL3 in its default state must produce the same
// bytes as an OPL2 -- not similar, the same. Everything below it is only worth
// reading if that holds.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { OPL2, OPL3 } from "../src/opl/chip.js";
import { waveform, expand, SILENCE } from "../src/opl/tables.js";
import { AdlibDriver, voiceLayout } from "../src/driver.js";
import { IyagiMusic, parseSop, sopPatch } from "../src/player.js";
import { sopSequence, NOTE_ON, NOTE_OFF, PATCH, PAN } from "../src/sequencer.js";
import {
  METER_VOICES, METER_STRIDE, RHYTHM_VOICES, R_BD, R_HH,
  M_PEAK, M_PAN, M_TIMBRE, M_NOTE, T_FOUROP,
  PAN_LEFT, PAN_RIGHT, PAN_CENTRE, PAN_NONE,
  CF_OPL3, CF_FOUROP, CF_RHYTHM,
  REG_OPL3_ENABLE, REG_FOUROP, OPL3_NEW, FOUROP_PAIRS,
} from "../src/opl/constants.js";

const CORPUS = "/home/torvald/Documents/tsvm/reference_materials/Iyagi Music Sound";
const MEGA = path.join(CORPUS, "IMS_FILE_MEGA_CORPUS");
const have = fs.existsSync(MEGA);
const sopFiles = () =>
  fs.readdirSync(MEGA).filter((f) => f.toUpperCase().endsWith(".SOP")).sort();
const read = (fn) => new Uint8Array(fs.readFileSync(path.join(MEGA, fn)));

const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
const peak = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const meters = (chip) => chip.readMeters(new Float32Array(METER_VOICES * METER_STRIDE));
const row = (m, voice, field) => m[voice * METER_STRIDE + field];

/** The register offsets of one channel, in whichever bank it lives. */
function regs(channel) {
  const bank = channel >= 9 ? 0x100 : 0;
  const c = channel % 9;
  const op = [0, 1, 2, 8, 9, 10, 16, 17, 18][c] + bank;
  return { a0: 0xa0 + c + bank, b0: 0xb0 + c + bank, c0: 0xc0 + c + bank, mod: op, car: op + 3 };
}

/**
 * A plain sine carrier on one channel, keyed on. `wave` is the carrier's
 * waveform and `mod` silences or sounds the modulator; an attack rate of zero
 * is how an operator is silenced throughout this file, because it leaves the
 * envelope pinned at its floor 96 dB down.
 */
function tone(chip, channel, { fnum = 580, block = 4, wave = 0, cnt = 1, modAttack = 0 } = {}) {
  const r = regs(channel);
  chip.write(0x01, 0x20);
  chip.write(0x20 + r.mod, 0x01); chip.write(0x20 + r.car, 0x01);
  chip.write(0x40 + r.mod, 0x00); chip.write(0x40 + r.car, 0x00);
  chip.write(0x60 + r.mod, (modAttack << 4) | 0); chip.write(0x60 + r.car, 0xf0);
  chip.write(0x80 + r.mod, 0x00); chip.write(0x80 + r.car, 0x00);
  chip.write(0xe0 + r.mod, wave); chip.write(0xe0 + r.car, wave);
  chip.write(r.c0, (PAN_CENTRE << 4) | cnt);
  chip.write(r.a0, fnum & 0xff);
  chip.write(r.b0, 0x20 | (block << 2) | ((fnum >> 8) & 3));
}

const render = (chip, n = 4096) => {
  const buf = new Float32Array(n);
  chip.generate(buf, 0, n);
  return buf;
};

/* ------------------------------------------------- compatibility with OPL2 */

test("a YMF262 before register 0x105 is a YM3812, sample for sample", () => {
  // Not "close enough": the same core runs both, so any difference is a branch
  // that fired when it should not have.
  const two = new OPL2(), three = new OPL3();
  for (const chip of [two, three]) {
    tone(chip, 0, { fnum: 690, block: 3 });
    tone(chip, 4, { fnum: 345, block: 4, wave: 2 });
    chip.write(0xbd, 0x20 | 0x10 | 0x01);          // rhythm, bass drum and hi-hat
  }
  assert.deepEqual([...render(three, 8192)], [...render(two, 8192)]);
  assert.equal(three.voiceRows, two.voiceRows);
  assert.equal(three.chipFlags & CF_OPL3, 0);
});

test("the second bank and the last four waveforms need NEW", () => {
  const chip = new OPL3();
  // Channel 9 is the second bank's first channel, and must be inaudible while
  // the chip is pretending to be a YM3812.
  tone(chip, 9);
  assert.equal(rms(render(chip)), 0, "bank 1 sounded before 0x105 was written");
  // 0xE0 is two bits wide until NEW widens it, so wave 6 becomes wave 2.
  chip.write(0xe0, 6);
  assert.equal(chip.operators[0].wave, 2);

  chip.write(REG_OPL3_ENABLE, OPL3_NEW);
  assert.ok(chip.chipFlags & CF_OPL3);
  assert.equal(chip.voiceRows, 18);
  assert.ok(rms(render(chip)) > 0.05, "bank 1 stayed silent after 0x105");
  chip.write(0xe0, 6);
  assert.equal(chip.operators[0].wave, 6);

  // Turning NEW back off takes the third bit away again, and with it the bank.
  chip.write(REG_OPL3_ENABLE, 0);
  assert.equal(chip.operators[0].wave, 2);
  assert.equal(chip.voiceRows, 9);
});

test("all thirty-six operators are individually addressable", () => {
  // The OPL2 version of this caught a real bug -- operator registers use five
  // address bits and channel registers four. Adding a bank multiplies the ways
  // to get it wrong, so every operator is poked and read back on its own.
  const chip = new OPL3();
  chip.write(REG_OPL3_ENABLE, OPL3_NEW);
  const offsets = [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 16, 17, 18, 19, 20, 21];
  const seen = new Set();
  offsets.forEach((off, i) => {
    for (const bank of [0, 0x100]) {
      chip.write(0x60 + off + bank, ((i % 15) + 1) << 4 | (i % 16));
      const index = i + (bank ? 18 : 0);
      const op = chip.operators[index];
      assert.equal(op.attack, (i % 15) + 1, `operator ${index} attack`);
      assert.equal(op.decay, i % 16, `operator ${index} decay`);
      assert.ok(!seen.has(index), `operator ${index} was written twice`);
      seen.add(index);
    }
  });
  assert.equal(seen.size, 36);
  // 6, 7, 14 and 15 are not operators in either bank, and writing them must
  // not land on one that is.
  for (const off of [6, 7, 14, 15, 22, 23]) {
    for (const bank of [0, 0x100]) {
      const before = chip.operators.map((o) => o.attack);
      chip.write(0x60 + off + bank, 0xff);
      assert.deepEqual(chip.operators.map((o) => o.attack), before,
        `0x${(0x60 + off + bank).toString(16)} reached an operator`);
    }
  }
});

/* ------------------------------------------------------- the new waveforms */

/**
 * A waveform at the operator's own output, unmodulated and slow enough to read
 * off the buffer rather than infer.
 *
 * At F-number 64, block 0 and multiple 1 the phase advances 64 accumulator
 * units a sample, so a full 1024-step waveform cycle takes 2^20 / 64 = 16384
 * samples -- which is `CYCLE` below, and is what makes eighths of a half cycle
 * a whole number of samples.
 */
const CYCLE = 16384;
function cycle(wave, n = 1 << 15) {
  const chip = new OPL3();
  chip.write(REG_OPL3_ENABLE, OPL3_NEW);
  tone(chip, 0, { fnum: 64, block: 0, wave });
  return render(chip, n);
}

test("the square waveform is a square", () => {
  // Waveform 6 is the only one with no attenuation anywhere, so its RMS and
  // its peak are the same number -- which is what "square" means numerically.
  const buf = cycle(6);
  assert.ok(Math.abs(rms(buf) / peak(buf) - 1) < 0.02,
    `rms/peak ${(rms(buf) / peak(buf)).toFixed(3)} is not a square`);
  // And it is the loudest waveform there is: nothing else sits at 0 dB
  // throughout, so a sine of the same settings must be quieter.
  assert.ok(rms(cycle(0)) < rms(buf) * 0.8);
});

test("the four new waveforms are the shapes the figure draws", () => {
  // Exactly, over all 1024 phases, at the table rather than at the output:
  // every one of them is defined as the OPL2's sine read differently, so each
  // line below is that definition turned round and asserted.
  const sign = [0];
  const value = (wave, phase) => {
    const att = waveform(wave, phase, sign);
    return att === SILENCE ? 0 : expand(att) * sign[0];
  };
  const full = value(6, 0);                      // the square's flat top: 0 dB
  for (let p = 0; p < 1024; p++) {
    assert.equal(value(4, p), p < 512 ? value(0, (2 * p) & 0x3ff) : 0,
      `waveform 4 at phase ${p}`);
    assert.equal(value(5, p), Math.abs(value(4, p)), `waveform 5 at phase ${p}`);
    assert.equal(value(6, p), p < 512 ? full : -full, `waveform 6 at phase ${p}`);
    // 7 is the only one that is not a rearrangement of the sine: a straight
    // line in the attenuation domain, 0 up to 0x1FF·8 and back, sign by half.
    assert.equal(waveform(7, p, sign), (p < 512 ? p : 0x3ff - p) << 3,
      `waveform 7 at phase ${p}`);
    assert.equal(sign[0], p < 512 ? 1 : -1, `waveform 7 sign at phase ${p}`);
  }
  // The ramp's top is the same 96 dB the envelope and the exponential span,
  // which is what makes half a cycle the chip's whole dynamic range.
  assert.equal(0x1ff << 3, 4088);
  assert.ok(Math.abs((4088 * 6.0206) / 256 - 96.14) < 0.01);
});

test("the even waveforms are silent through half of every cycle", () => {
  // The table says so; this says the silence survives the operator, the
  // envelope and the mix bus on the way out.
  for (const wave of [4, 5]) {
    const buf = cycle(wave);
    const zeros = buf.reduce((n, v) => n + (v === 0 ? 1 : 0), 0) / buf.length;
    assert.ok(Math.abs(zeros - 0.5) < 0.02,
      `waveform ${wave}: ${(zeros * 100).toFixed(1)}% silent, want 50%`);
  }
  assert.ok(Math.min(...cycle(4)) < -0.05, "waveform 4 lost its negative half");
  assert.ok(Math.min(...cycle(5)) >= 0, "waveform 5 is not rectified");
});

test("the sawtooth falls twelve decibels an eighth of a half cycle", () => {
  // 96.14 dB across a half cycle is 12.02 dB an eighth of one. Measuring it at
  // the output is what says the ramp reaches the ear as a ramp rather than
  // being flattened by the envelope or the exponential on the way.
  const buf = cycle(7, CYCLE * 3);
  // Start on the second cycle, past the attack, at the phase where the ramp
  // restarts -- which is where the half cycle is loudest.
  let start = CYCLE;
  for (let i = CYCLE; i < CYCLE + 128; i++) {
    if (Math.abs(buf[i]) > Math.abs(buf[start])) start = i;
  }
  const half = CYCLE / 2;
  const at = (k) => buf[start + Math.round((half * k) / 8)];
  const db = (k) => 20 * Math.log10(Math.abs(at(k)) / Math.abs(at(0)));
  // Only the first half of the ramp: past about 50 dB down the chip's own
  // integer exponential quantises hard, and that is the chip, not the shape.
  for (let k = 1; k <= 4; k++) {
    const drop = db(k) - db(k - 1);
    assert.ok(Math.abs(drop + 96.14 / 8) < 2,
      `eighth ${k} fell ${drop.toFixed(2)} dB, want ${(-96.14 / 8).toFixed(2)}`);
  }
  // The two halves meet at silence and differ only in sign, which is what
  // makes it a sawtooth rather than a ramp that jumps.
  assert.ok(at(0) > 0, "the first half is not positive");
  assert.ok(Math.abs(at(7)) < Math.abs(at(0)) * 1e-3,
    "the first half did not reach silence before the second began");
  assert.ok(buf[start + half + Math.round((half * 7) / 8)] < 0,
    "the second half is not the first inverted");
});

/* ------------------------------------------------- four-operator channels */

/** A four-operator pair with exactly one of its operators audible. */
function fourOp(audible, { cnt1 = 0, cnt2 = 0 } = {}) {
  const chip = new OPL3();
  chip.write(REG_OPL3_ENABLE, OPL3_NEW);
  chip.write(REG_FOUROP, 1);                      // join channels 0 and 3
  const head = regs(0), slave = regs(3);
  const ops = [head.mod, head.car, slave.mod, slave.car];
  ops.forEach((op, i) => {
    chip.write(0x20 + op, 0x01);
    chip.write(0x40 + op, 0x00);
    // Attack 0 pins the envelope at its floor: silent, without changing
    // anything about how the operator is wired.
    chip.write(0x60 + op, i === audible ? 0xf0 : 0x00);
    chip.write(0x80 + op, 0x00);
    chip.write(0xe0 + op, 0);
  });
  chip.write(head.c0, (PAN_CENTRE << 4) | cnt1);
  chip.write(slave.c0, (PAN_CENTRE << 4) | cnt2);
  for (const r of [head, slave]) {
    chip.write(r.a0, 580 & 0xff);
    chip.write(r.b0, 0x20 | (4 << 2) | (580 >> 8));
  }
  return chip;
}

test("the four connections are the four the register pair names", () => {
  // Reading each half's CNT bit as "this half's first operator goes straight
  // to the output" names all four connections at once, and each row here is
  // one of them: an operator that reaches the output must be audible on its
  // own, and one that only modulates a silenced operator must not.
  //
  //   0,0   1 → 2 → 3 → 4          0,1   1 → 2 → 3, and 4
  //   1,0   1, and 2 → 3 → 4       1,1   1, and 2 → 3, and 4
  const outputs = {
    "0,0": [false, false, false, true],
    "0,1": [false, false, true, true],
    "1,0": [true, false, false, true],
    "1,1": [true, false, true, true],
  };
  for (const [name, wanted] of Object.entries(outputs)) {
    const [cnt1, cnt2] = name.split(",").map(Number);
    wanted.forEach((reaches, op) => {
      const level = rms(render(fourOp(op, { cnt1, cnt2 })));
      if (reaches) {
        assert.ok(level > 0.02,
          `connection ${name}: operator ${op + 1} should reach the output (${level})`);
      } else {
        assert.ok(level < 0.001,
          `connection ${name}: operator ${op + 1} should only modulate (${level})`);
      }
    });
  }
});

test("a joined pair is one voice: one key-on, one pitch, one meter row", () => {
  const chip = fourOp(3);
  // The head was keyed; the slave's own 0xB0 key-on bit was never set, and its
  // two operators must be running all the same.
  assert.equal(chip.channels[3].keyOn, true, "the slave's register still reads what was written");
  const buf = render(chip);
  assert.ok(rms(buf) > 0.02);

  // The slave's F-number is not read: all four operators follow the head. Two
  // chips rather than two renders of one, because an envelope in motion would
  // differ between the halves of a single run for reasons of its own.
  const retuned = fourOp(3);
  retuned.write(regs(3).a0, 0x11);
  retuned.write(regs(3).b0, 0x20 | (7 << 2) | 1);
  assert.deepEqual([...render(retuned, 2048)], [...render(fourOp(3), 2048)],
    "the slave's own pitch reached its operators");

  const m = meters(chip);
  assert.ok(row(m, 0, M_PEAK) > 0.01, "the pair did not meter on its head");
  assert.equal(row(m, 3, M_PEAK), 0, "the slave reported a voice of its own");
  assert.equal((row(m, 0, M_TIMBRE) | 0) >> T_FOUROP & 1, 1, "the row does not say four-operator");
  assert.ok(chip.chipFlags & CF_FOUROP);

  // Splitting the pair gives the slave back.
  chip.write(REG_FOUROP, 0);
  assert.equal(chip.chipFlags & CF_FOUROP, 0);
  assert.equal(chip.channels[3].pairRole, 0);
});

test("only the six documented channel pairs can be joined", () => {
  const chip = new OPL3();
  chip.write(REG_OPL3_ENABLE, OPL3_NEW);
  chip.write(REG_FOUROP, 0x3f);
  const joined = chip.channels.filter((c) => c.pairRole !== 0).map((c) => c.index);
  assert.deepEqual(joined.sort((a, b) => a - b),
    FOUROP_PAIRS.flat().sort((a, b) => a - b));
  // Every pair is a channel and the one three above it, in the same bank.
  for (const [head, slave] of FOUROP_PAIRS) {
    assert.equal(slave - head, 3);
    assert.equal(head >= 9, slave >= 9);
  }
});

/* ------------------------------------------------------------ the stereo */

test("the stereo switches route a voice, and mono ignores them", () => {
  const cases = [[PAN_LEFT, true, false], [PAN_RIGHT, false, true],
    [PAN_CENTRE, true, true], [PAN_NONE, false, false]];
  for (const [pan, wantL, wantR] of cases) {
    const chip = new OPL3();
    chip.write(REG_OPL3_ENABLE, OPL3_NEW);
    tone(chip, 0);
    chip.write(regs(0).c0, (pan << 4) | 1);
    const L = new Float32Array(4096), R = new Float32Array(4096);
    chip.generateStereo(L, R, 0, 4096);
    assert.equal(rms(L) > 0.01, wantL, `pan ${pan}: left`);
    assert.equal(rms(R) > 0.01, wantR, `pan ${pan}: right`);
    // The mono bus is the chip's own sum and does not read the switches, so a
    // hard-panned voice is in it at full level -- as it is on a YM3812.
    assert.ok(rms(render(chip)) > 0.01, `pan ${pan}: mono`);
    assert.equal(row(meters(chip), 0, M_PAN), pan);
  }
});

test("a chip without the switches renders the same stream twice", () => {
  const chip = new OPL2();
  tone(chip, 0);
  const L = new Float32Array(2048), R = new Float32Array(2048);
  chip.generateStereo(L, R, 0, 2048);
  assert.deepEqual([...L], [...R]);
  assert.equal(row(meters(chip), 0, M_PAN), PAN_CENTRE);
});

/* ------------------------------------------------------------- the driver */

test("the driver reaches every voice of an OPL3, in both modes", () => {
  const patch = {
    name: "T",
    modulator: { ksl: 0, multiple: 1, feedback: 0, attack: 15, sustain: 10, eg: 1, decay: 0, release: 5, totalLevel: 20, am: 0, vib: 0, ksr: 0, connection: 1 },
    carrier: { ksl: 0, multiple: 1, feedback: 0, attack: 15, sustain: 10, eg: 1, decay: 0, release: 5, totalLevel: 0, am: 0, vib: 0, ksr: 0, connection: 1 },
    modWave: 0, carWave: 0,
  };
  for (const percussive of [false, true]) {
    const count = percussive ? 20 : 18;
    for (let v = 0; v < count; v++) {
      const chip = new OPL3();
      const driver = new AdlibDriver(chip, { opl3: true });
      driver.setMode(percussive);
      assert.equal(driver.voiceCount, count);
      driver.setVoiceTimbre(v, patch);
      driver.setVoiceVolume(v, 127);
      driver.noteOn(v, 60);
      assert.ok(rms(render(chip, 8192)) > 0.002,
        `${percussive ? "percussive" : "melodic"} voice ${v} was silent`);
    }
  }
});

test("the five rhythm voices are the last five, on either chip", () => {
  for (const opl3 of [false, true]) {
    const layout = voiceLayout(opl3, true);
    assert.equal(layout.rhythmBase, layout.voiceCount - RHYTHM_VOICES);
    assert.equal(layout.melodicVoices, layout.rhythmBase);
    const chip = opl3 ? new OPL3() : new OPL2();
    const driver = new AdlibDriver(chip, { opl3 });
    driver.setMode(true);
    assert.equal(driver.rhythmBase, layout.rhythmBase);
    assert.equal(driver.bd, layout.rhythmBase);
    assert.equal(driver.hh, layout.rhythmBase + 4);
    // The chip has to agree with the driver, or the meters point at the wrong
    // columns -- which is the one thing a display cannot detect for itself.
    assert.equal(chip.rhythmRow, driver.rhythmBase);
    assert.equal(chip.voiceRows, driver.voiceCount);
    assert.ok(chip.chipFlags & CF_RHYTHM);
  }
});

test("a rhythm voice meters on its own row on an OPL3", () => {
  const chip = new OPL3();
  const driver = new AdlibDriver(chip, { opl3: true });
  driver.setMode(true);
  const drum = {
    name: "D",
    modulator: { ksl: 0, multiple: 1, feedback: 0, attack: 15, sustain: 8, eg: 0, decay: 4, release: 6, totalLevel: 0, am: 0, vib: 0, ksr: 0, connection: 1 },
    carrier: { ksl: 0, multiple: 1, feedback: 0, attack: 15, sustain: 8, eg: 0, decay: 4, release: 6, totalLevel: 0, am: 0, vib: 0, ksr: 0, connection: 1 },
    modWave: 0, carWave: 0,
  };
  driver.setVoiceTimbre(driver.hh, drum);
  driver.setVoiceVolume(driver.hh, 127);
  driver.noteOn(driver.hh, 60);
  render(chip, 4096);
  const m = meters(chip);
  assert.ok(row(m, driver.rhythmBase + R_HH, M_PEAK) > 0.01, "the hi-hat did not meter");
  assert.equal(row(m, driver.rhythmBase + R_BD, M_PEAK), 0, "it leaked into the bass drum");
  // §6: the hi-hat's phase is not its channel's pitch, so it reports no note.
  assert.equal(row(m, driver.rhythmBase + R_HH, M_NOTE), -1);
});

test("the OPL2 driver on an OPL3 chip is an OPL2", () => {
  // Anything that reaches for the second bank or the stereo switches without
  // being asked would show up here as a difference.
  const patch = {
    name: "T",
    modulator: { ksl: 1, multiple: 2, feedback: 4, attack: 12, sustain: 6, eg: 1, decay: 3, release: 4, totalLevel: 18, am: 1, vib: 0, ksr: 1, connection: 1 },
    carrier: { ksl: 0, multiple: 1, feedback: 0, attack: 15, sustain: 9, eg: 0, decay: 5, release: 7, totalLevel: 0, am: 0, vib: 1, ksr: 0, connection: 1 },
    modWave: 3, carWave: 1,
  };
  const run = (chip) => {
    const driver = new AdlibDriver(chip);          // no opl3 option
    driver.setMode(true);
    for (let v = 0; v < driver.voiceCount; v++) {
      driver.setVoiceTimbre(v, patch);
      driver.setVoiceVolume(v, 90 + v);
      driver.noteOn(v, 48 + v);
    }
    return [...render(chip, 8192)];
  };
  assert.deepEqual(run(new OPL3()), run(new OPL2()));
});

/* ------------------------------------------------------- SOP on the OPL3 */

const N_TRACKS = 20;

/** Build a SOP by hand, as `sop.test.js` does, so the plan is checked not guessed. */
function buildSop({ percussive = 1, chanMode = new Array(N_TRACKS).fill(2),
  instruments = [], tracks = new Array(N_TRACKS).fill(null).map(() => []), control = [] } = {}) {
  const out = [];
  const str = (s, n) => {
    const b = new Array(n).fill(0);
    for (let i = 0; i < Math.min(s.length, n); i++) b[i] = s.charCodeAt(i);
    return b;
  };
  const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
  out.push(..."sopepos".split("").map((c) => c.charCodeAt(0)), 0, 1, 0);
  out.push(...str("T.SOP", 13), ...str("T", 31));
  out.push(percussive, 0, 8, 0, 4, 120);
  out.push(...str("", 13), N_TRACKS, instruments.length, 0);
  out.push(...chanMode);
  for (const i of instruments) {
    out.push(i.type, ...str(i.shortName ?? "", 8), ...str(i.longName ?? "", 19), ...(i.data ?? []));
  }
  const body = (events, isControl) => {
    const bytes = [];
    for (const e of events) {
      bytes.push(...u16(e.delta), e.code, e.value);
      if (!isControl && e.code === 2) bytes.push(...u16(e.length));
    }
    return [...u16(events.length), ...u32(bytes.length), ...bytes];
  };
  for (const t of tracks) out.push(...body(t, false));
  out.push(...body(control, true));
  return new Uint8Array(out);
}

const TWO_OP = {
  type: 1, shortName: "PIANO",
  data: [0x30, 0x10, 0xf3, 0x23, 0x07, 0x06, 0x11, 0x00, 0xf2, 0x33, 0x04],
};
const FOUR_OP = { type: 0, shortName: "FOUR", data: [...TWO_OP.data, ...TWO_OP.data] };

test("a four-operator instrument keeps its second pair", () => {
  const song = parseSop(buildSop({ instruments: [FOUR_OP, TWO_OP] }));
  const wide = sopPatch(song.instruments[0]);
  assert.ok(wide.pair, "the second operator pair was dropped");
  assert.deepEqual(wide.pair.modulator, wide.modulator);
  assert.equal(wide.pair.carWave, wide.carWave);
  // §3.2: a two-operator instrument has no second pair to keep.
  assert.equal(sopPatch(song.instruments[1]).pair, undefined);
});

test("twenty tracks fit an OPL3 in rhythm mode with nothing stolen", () => {
  // SOP §4.1 counts twenty voices and means it: fifteen melodic channels plus
  // the five rhythm ones. On a chip that has them, no note is ever cut short.
  const tracks = new Array(N_TRACKS).fill(null).map((_, t) => ([
    { delta: 0, code: 6, value: 0 },
    { delta: t, code: 2, value: 48 + (t % 24), length: 512 },
  ]));
  const song = parseSop(buildSop({ percussive: 1, instruments: [TWO_OP], tracks }));
  const layout = voiceLayout(true, true);
  const seq = sopSequence(song, layout);
  const held = new Set();
  let stolen = 0;
  for (const e of seq) {
    if (e.type === NOTE_ON) {
      if (held.has(e.voice)) stolen++;
      held.add(e.voice);
    } else if (e.type === NOTE_OFF) held.delete(e.voice);
    if (e.voice !== undefined) {
      assert.ok(e.voice >= 0 && e.voice < layout.voiceCount, `voice ${e.voice}`);
    }
  }
  assert.equal(stolen, 0, "a note was cut short on a chip with room for it");
  // Every one of the twenty tracks reached a voice of its own.
  const used = new Set(seq.filter((e) => e.type === NOTE_ON).map((e) => e.voice));
  assert.equal(used.size, N_TRACKS);
});

test("a mode-1 track gets a four-operator voice, and the extras do not", () => {
  // §2: the channel-mode table is what asks for a four-operator channel. A
  // chip offers six, so the seventh mode-1 track has to fall back.
  const chanMode = new Array(N_TRACKS).fill(2);
  for (let t = 11; t < 19; t++) chanMode[t] = 1;        // eight of them, past the drums
  const tracks = new Array(N_TRACKS).fill(null).map(() => []);
  for (let t = 11; t < 19; t++) {
    tracks[t] = [{ delta: 0, code: 6, value: 0 }, { delta: 1, code: 2, value: 60, length: 32 }];
  }
  const song = parseSop(buildSop({ percussive: 1, instruments: [FOUR_OP], tracks, chanMode }));
  const layout = voiceLayout(true, true);
  const seq = sopSequence(song, layout);
  const heads = new Set(layout.fourOpPairs.map(([h]) => h));
  const slaves = new Set(layout.fourOpPairs.map(([, s]) => s));
  const voices = new Set(seq.filter((e) => e.type === NOTE_ON).map((e) => e.voice));
  assert.equal([...voices].filter((v) => heads.has(v)).length, 6,
    "the six four-operator voices were not all taken");
  assert.equal([...voices].filter((v) => slaves.has(v)).length, 0,
    "a note landed on the slave half of a joined pair");
  assert.equal(voices.size, 8, "the two tracks past the sixth pair fell silent");

  // And on a chip with no pairs at all, nothing is wide and nothing breaks.
  const narrow = sopSequence(song, voiceLayout(false, true));
  for (const e of narrow) {
    if (e.voice !== undefined) assert.ok(e.voice <= 10, `voice ${e.voice} on an OPL2`);
  }
});

test("panning reaches the voice the track's notes landed on", () => {
  const tracks = new Array(N_TRACKS).fill(null).map(() => []);
  tracks[0] = [
    { delta: 0, code: 6, value: 0 },
    { delta: 0, code: 7, value: 2 },                     // §4.2: 2 is left
    { delta: 1, code: 2, value: 60, length: 16 },
  ];
  const song = parseSop(buildSop({ percussive: 0, instruments: [TWO_OP], tracks }));
  const seq = sopSequence(song, voiceLayout(true, false));
  const pan = seq.find((e) => e.type === PAN);
  assert.ok(pan, "the panning event was dropped");
  assert.equal(pan.pan, PAN_LEFT);
  const note = seq.find((e) => e.type === NOTE_ON);
  assert.equal(pan.voice, note.voice);
  // It is only sent when it moves, so a second note does not repeat it.
  assert.equal(seq.filter((e) => e.type === PAN).length, 1);
});

/* ---------------------------------------------------------------- corpus */

test("every corpus SOP plays on the OPL3", { skip: !have }, () => {
  let panned = 0, wide = 0, silent = 0;
  // §8 used to say a four-operator instrument lost half of itself and that 61
  // files were affected. All 61 get four operators now, which is the whole
  // point of this file.
  for (const fn of sopFiles()) {
    const m = new IyagiMusic({ song: read(fn), sampleRate: 48000 });
    assert.equal(m.chipKind, "opl3", fn);
    assert.equal(m.stereo, true, fn);
    const L = new Float32Array(48000 * 2), R = new Float32Array(48000 * 2);
    m.renderStereo(L, R, 0, L.length);
    let diff = 0;
    for (let i = 0; i < L.length; i += 17) diff += Math.abs(L[i] - R[i]);
    // Two seconds is enough to catch a panned voice but not every one of them;
    // the number below is what two seconds finds, not how many files pan.
    if (diff > 1) panned++;
    // Off the plan rather than off the registers: which tracks get a
    // four-operator voice is decided once, before a sample is rendered, so
    // this does not depend on how far into the song the test got.
    if (m.sequencer.makeEvents.some((e) => e.type === PATCH && e.patch && e.patch.pair)) wide++;
    if (rms(L) < 0.002 && rms(R) < 0.002) silent++;
  }
  // The corpus's own numbers, pinned so that a regression shows as one. They
  // are what a two-second window finds, not what the whole corpus contains:
  // plenty of these songs open quietly, so `silent` counts slow starts as much
  // as silence, and is here because a broken OPL3 path would send it to 336.
  assert.equal(wide, 61, "files whose four-operator instrument reaches four operators");
  assert.equal(panned, 177, "files whose stereo switches have parted by two seconds");
  assert.equal(silent, 71, "files with nothing audible in their first two seconds");
});

test("a four-operator corpus SOP uses four operators", { skip: !have }, () => {
  const fn = sopFiles().find((f) => parseSop(read(f)).instruments.some((i) => i.type === 0)
    && parseSop(read(f)).tracks.some((t) => (t.mode & 0x7f) === 1));
  const m = new IyagiMusic({ song: read(fn), sampleRate: 48000 });
  m.renderAll(4);
  assert.notEqual(m.chip.fourOpBits, 0, `${fn}: no channel pair was ever joined`);
  assert.ok(m.chipFlags & CF_FOUROP);
  // The same file on the old nine-voice path must still play -- SOP §8 is a
  // documented fallback, not a dead branch.
  const narrow = new IyagiMusic({ song: read(fn), sampleRate: 48000, chip: "opl2" });
  assert.equal(narrow.chip.opl3, false);
  assert.equal(narrow.chip.fourOpBits, 0, "a YM3812 has no pairs to join");
  assert.ok(rms(narrow.renderAll(4)) > 0.005, `${fn}: silent on the OPL2 path`);
});

test("the OPL3 wave selects reach the chip", { skip: !have }, () => {
  // SOP §3.2 stores wave selects 0..7 and an OPL2 can only take 0..3, so this
  // is one of the four losses §8 used to list. It should not be lossy now.
  let seen = new Set();
  for (const fn of sopFiles()) {
    for (const inst of parseSop(read(fn)).instruments) {
      const p = sopPatch(inst);
      if (p) { seen.add(p.modWave); seen.add(p.carWave); }
    }
    if (seen.size >= 8) break;
  }
  assert.ok([...seen].some((w) => w > 3), "the corpus has no OPL3 wave selects at all");
  const chip = new OPL3();
  const driver = new AdlibDriver(chip, { opl3: true });
  driver.setVoiceTimbre(0, {
    name: "W", modWave: 7, carWave: 6,
    modulator: { ksl: 0, multiple: 1, feedback: 0, attack: 15, sustain: 0, eg: 1, decay: 0, release: 0, totalLevel: 0, am: 0, vib: 0, ksr: 0, connection: 1 },
    carrier: { ksl: 0, multiple: 1, feedback: 0, attack: 15, sustain: 0, eg: 1, decay: 0, release: 0, totalLevel: 0, am: 0, vib: 0, ksr: 0, connection: 1 },
  });
  assert.equal(chip.channels[0].mod.wave, 7);
  assert.equal(chip.channels[0].car.wave, 6);
  // On a YM3812 the same patch is masked to the four it has, not rejected.
  const two = new OPL2();
  const narrow = new AdlibDriver(two);
  narrow.setVoiceTimbre(0, {
    name: "W", modWave: 7, carWave: 6,
    modulator: { ksl: 0, multiple: 1, feedback: 0, attack: 15, sustain: 0, eg: 1, decay: 0, release: 0, totalLevel: 0, am: 0, vib: 0, ksr: 0, connection: 1 },
    carrier: { ksl: 0, multiple: 1, feedback: 0, attack: 15, sustain: 0, eg: 1, decay: 0, release: 0, totalLevel: 0, am: 0, vib: 0, ksr: 0, connection: 1 },
  });
  assert.equal(two.channels[0].mod.wave, 3);
  assert.equal(two.channels[0].car.wave, 2);
});
