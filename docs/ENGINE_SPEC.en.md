# Iyagi Music Sound — playback engine specification

How an `.ims` or `.rol` file is turned into OPL2 (YM3812) register writes.

The behaviour described here is that of AdLib's own low-level driver, the one
shipped with the *AdLib Programmer's Manual* and reused by essentially every
DOS player of these formats. It is described here as an algorithm, in prose
and pseudocode, so that it can be reimplemented from scratch. Where a
widely-circulated player deviates from it, the deviation is noted so that
implementers can recognise — and not copy — the bug.

Register numbers below are OPL2 register addresses. "Operator offset" means
the value added to a base register address to reach a particular operator.

---

## 1. Machine model

Nine **voices** (0–8) in melodic mode; eleven **logical voices** (0–10) in
percussive mode, where 0–5 are ordinary two-operator voices and 6–10 are the
rhythm instruments sharing the chip's channels 6–8.

Eighteen **operators**. Operator *o* (0 = modulator, 1 = carrier) of melodic
voice *v* has register offset:

```
opOffset(v, o) = [0,1,2,8,9,10,16,17,18][v] + 3*o
```

In percussive mode voices 0–5 keep that mapping and the rhythm voices use a
single fixed operator each:

| Logical voice | Instrument | Operator offset | Operators used |
|---------------|------------|-----------------|----------------|
| 6  | Bass drum  | 16 and 19 | both |
| 7  | Snare drum | 20        | carrier only |
| 8  | Tom tom    | 18        | modulator only |
| 9  | Top cymbal | 21        | carrier only |
| 10 | Hi-hat     | 17        | modulator only |

> The four single-operator rhythm voices take their settings from the patch's
> **modulator** fields regardless of which physical operator they end up in.
> The carrier fields of a drum patch are unused.

Per-voice state an implementation must keep:

- `note[9]` — chip note number of the last note-on
- `keyOn[9]` — 0x20 or 0
- `bend[9]` — 14-bit pitch bend, 8192 = centre
- `bxCache[9]` — last value written to register 0xB0+v
- `volume[11]` — 0–127, one per *logical* voice (so 11, not 9)
- `percBits` — the five rhythm key-on bits

## 2. Reset

1. Zero registers 0x01 through 0xF5.
2. Write 0x06 to register 0x04 (mask both timers).
3. `bend[v] = 8192`, `keyOn[v] = 0`, `note[v] = 0` for all nine voices.
4. `volume[v] = 127` for all eleven logical voices.
5. Select melodic or percussive mode (§6) and load the default patches.
6. Global AM depth, vibrato depth and note-select are all 0. Neither IMS nor
   ROL can change them.
7. Pitch-bend range = 1 semitone, then overwritten from the file header.
8. Enable wave select: write 0 to every 0xE0+offset, then 0x20 to register
   0x01.

Both formats leave every voice loaded with the driver's built-in electric
piano until a patch change arrives. In practice this never matters for IMS —
every corpus file issues a patch change on every channel before its first
note — but a ROL voice with an empty timbre track really will play the
default patch.

## 3. Loading a patch

A bank record supplies thirteen parameters per operator plus a wave-select
value per operator (see `FILE_FORMATS.en.md` §2.3). They become register
writes as follows. `off` is the operator offset from §1.

| Register  | Contents |
|-----------|----------|
| `0x20+off` | `am?0x80` \| `vib?0x40` \| `eg?0x20` \| `ksr?0x10` \| `multiple & 0x0F` |
| `0x40+off` | `(ksl & 3) << 6` \| output level, see §4 |
| `0x60+off` | `(attack & 0x0F) << 4` \| `decay & 0x0F` |
| `0x80+off` | `(sustain & 0x0F) << 4` \| `release & 0x0F` |
| `0xE0+off` | `waveSel & 0x03` (or 0 if wave select is disabled) |
| `0xC0+v`   | `(feedback & 7) << 1` \| `connection ? 0 : 1` — **modulator only** |

Note the inversion in the last row: the parameter is *"FM"*, so a **zero**
parameter sets the chip's additive bit. `am`, `vib`, `eg`, `ksr` and
`connection` are booleans — any non-zero value counts as set — and the
numeric fields must be masked, because real banks contain values up to 255 in
every field.

Feedback and connection live on the modulator only; the carrier's copies of
those two parameters are ignored.

Global writes, all of which stay constant for these formats:

- `0x08` ← 0 (note-select off)
- `0xBD` ← `amDepth?0x80 | vibDepth?0x40 | percussion?0x20 | percBits`
- `0x01` ← 0x20 (wave select enabled)

## 4. Volume

The 0x40 register holds `ksl` in bits 6–7 and a 6-bit **attenuation** in bits
0–5, where 63 is silence. Channel volume scales the patch's own level:

```
amplitude = 63 - (totalLevel & 63)

if operator is a carrier
   or the voice's connection parameter is 0 (additive)
   or the voice is a single-operator rhythm voice:
       amplitude = (amplitude * volume + 64) >> 7

write 0x40+off  ←  (63 - amplitude) | ((ksl & 3) << 6)
```

`volume` is the logical voice's 0–127 channel volume, clamped at 127. The
`+ 64` is a rounding term, not a fudge: it is `(127+1)/2`.

The three-way condition is the important part. In a two-operator FM voice only
the carrier's level is audible as loudness, so scaling the modulator would
change the *timbre* rather than the volume — hence modulators are left alone
**unless** the voice is additive, in which case the modulator is heard
directly and must be scaled too. Early AdLib drivers got this wrong; the
1990 revision fixed it, and that fixed behaviour is what these files were
written against.

This write must be repeated whenever the channel volume changes, for every
operator of the voice.

## 5. Pitch

### 5.1 The frequency table

A table of 192 F-numbers covers one octave in steps of 1/16 semitone: entry
`s*16 + f` is semitone `s` (0–11), sixteenth `f` (0–15). It is very close to

```
fnum(i) = round(689.76 * 2^(i/192))
```

— the F-number for middle C at block 3 on a 3.579545 MHz OPL2 — but 24 of the
192 entries in the canonical table differ from that formula by ±1 LSB, i.e.
about a quarter of a cent. Ship the canonical table if you want bit-exact
output; the formula is fine if you do not.

Entries that would exceed the chip's 10-bit F-number are stored **halved with
the top byte set to 0xFE**. So the decoding rule for a table entry `e` is:

```
if e & 0x8000:  block += 1
fnum = e & 0x03FF
```

### 5.2 Note to registers

`pitchRange` is the file's pitch-bend range, 1–12 semitones, clamped into that
interval. `note` is the **chip** note number: subtract 12 from the MIDI note
number, then clamp at 0. (MIDI 60 = middle C becomes chip note 48.)

```
bendOffset = ((bend - 8192) >> 5) * pitchRange     // 8.8 fixed point
t          = (note << 8) + bendOffset
t          = (t + 8) >> 4                          // round to 1/16 semitone
clamp t to [0, 96*16 - 1]

semitone = t >> 4
sixteenth = t & 15
e     = fnumTable[(semitone % 12) * 16 + sixteenth]
block = (semitone / 12) - 1
if e & 0x8000: block += 1
if block < 0:  block += 1; e >>= 1                 // bottom octave
fnum = e & 0x03FF

write 0xA0+v ← fnum & 0xFF
write 0xB0+v ← keyOn | ((block & 7) << 2) | ((fnum >> 8) & 3)
```

Cache the 0xB0 value: note-off needs it (§7).

All arithmetic is 16-bit two's complement. `bend - 8192` gives ±8192; the
`>> 5` reduces it to ±256 = ±1 semitone in 8.8 fixed point, and multiplying by
`pitchRange` widens it to the file's declared range.

> **Deviation to avoid.** One circulating player adds 0x800 to the bend before
> calling this routine, for voices 0–6 only. At the near-universal
> `pitchBRange = 1` that plays the melodic voices a quarter-semitone sharp
> while leaving the toms and snare in tune. It is a bug, not a tuning
> convention.

## 6. Rhythm mode

Melodic mode: nine voices, `percBits = 0`, bit 5 of 0xBD clear.

Percussive mode: bit 5 of 0xBD set, eleven logical voices, and on entry the
driver seeds

```
note[tom]   = 24        // two octaves below chip middle C
note[snare] = 24 + 7
bend[tom] = bend[snare] = 8192
```

and pushes both through §5.2 before anything else happens.

Only the bass drum and the tom carry their own pitch. The other three share
chip channels with them:

- **Tom (voice 8)** takes the pitch from its note-on. When — and only when —
  it *changes*, the snare is re-tuned to tom + 7 semitones and both are
  rewritten.
- **Snare (7)** always sounds 7 semitones above the last tom note.
- **Top cymbal (9)** and **hi-hat (10)** have no pitch of their own; they are
  driven by the chip channels the tom and snare occupy.
- **Bass drum (6)** is an ordinary two-operator voice with its own pitch and
  its own bend.

Pitch bend applies to melodic voices and to the bass drum. It is ignored on
voices 7–10.

## 7. Note on and note off

**Melodic voice, note on:** `note[v] = chipNote`, `keyOn[v] = 0x20`, run §5.2.

**Melodic voice, note off:** `keyOn[v] = 0`, clear bit 5 of the cached 0xB0
value and write it back. Do *not* recompute the frequency — writing a stale
F-number here is what gives these files their characteristic release.

**Rhythm voice, note on:** update the pitch as described in §6 if the voice is
the bass drum or the tom, then set the voice's bit in `percBits` and write
0xBD.

Rhythm key-on bits in register 0xBD: bass drum 0x10, snare 0x08, tom 0x04,
top cymbal 0x02, hi-hat 0x01.

**Rhythm voice, note off:** clear the bit and write 0xBD.

Because rhythm key-on is a single shared register, a rhythm voice must be
keyed *off* before it can be keyed on again — a retrigger that only sets an
already-set bit produces no new attack.

## 8. Event dispatch (IMS)

Per `FILE_FORMATS.en.md` §1.4, with the driver calls filled in:

| Message | Action |
|---------|--------|
| `9n nn vv`, `vv > 0` | note off voice *n*; set channel volume to `vv`; note on `nn` |
| `9n nn 00`           | note off voice *n* |
| `8n nn vv`           | note off voice *n*; if `vv > 0`, set channel volume to `vv` and note on `nn` |
| `An vv`              | set channel volume to `vv` |
| `Cn ii`              | load patch table entry `ii` into voice *n* |
| `En ll mm`           | `bend[n] = ll | (mm << 7)`; re-run §5.2 for voice *n* |
| `F0 7F 00 ii ff F7`  | `tempo = basicTempo * (ii + ff/128)` |
| `FC`                 | stop, or loop |

Note-on always begins with a note-off on the same voice, so a repeated note
retriggers the envelope rather than gliding.

Events addressed to a voice the current mode does not have (channels 9 and 10
in melodic mode) are discarded before any of this.

## 9. Clock

```
secondsPerTick = 60 / (tempo * tickBeat)
```

with `tempo` the current tempo in BPM after any multiplier event, and
`tickBeat` from the header (always 240 in IMS). For a renderer working in
samples:

```
samplesToNextEvent = round(sampleRate * 60 * delayTicks / (tempo * tickBeat))
```

A delay of zero means the next event happens on the same tick; process events
in a loop until a non-zero delay appears, then render.

For ROL, the same formula applies with the ROL header's `tickBeat` and
`basicTempo`, and the tempo track's multipliers.

## 10. Emulation notes

These files were written for a real YM3812 at 3.579545 MHz. Anything that
implements the register set faithfully will do; the format makes no use of
timers, no use of the 0x08 note-select bit, and no use of AM/vibrato depth.
Wave select is used, so an OPL1-only emulation (sine only) will sound wrong on
a large fraction of the corpus.
