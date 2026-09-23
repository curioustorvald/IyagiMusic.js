# Iyagi Music Sound — playback engine specification

How an `.ims` or `.rol` file is turned into OPL2 (YM3812) register writes —
and, in §10 and §11, what changes when the chip underneath is an OPL3
(YMF262) instead.

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

**On a YMF262 the same model has eighteen channels** and therefore 18 logical
voices, or 15 + 5 in percussive mode, because the rhythm instruments still take
over channels 6, 7 and 8 of the *first* bank and the second bank keeps all
nine. The numbering follows one rule on either chip: melodic voices in channel
order, then the five rhythm voices on the end. **The rhythm voices are always
the last five**, whether that is 6–10 of eleven or 15–19 of twenty, which is
what lets a display index a voice without knowing which chip it is looking at.
See §10 and §11 for what else changes; nothing in §2 through §9 does.

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

**IMPLAY does not do this for additive modulators** *(IMPLAY.EXE)*. Its driver
scales a carrier, or a single-operator rhythm voice, by the channel volume. It
leaves an FM modulator alone, as above. But it scales an additive modulator by
the user's mixer level for that channel, which is 127 unless someone moved
the slider, and never by the song's volume. So in IMPLAY, `An` fades and
note-on volumes do not reach the modulator of an additive patch. That is the
early-driver behaviour this section describes as a bug, and it is what these
files were heard with. This library follows the corrected form above.

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

> **Two more deviations to avoid**, both from the other circulating player.
> It omits the −12 transpose of §5.2, so every note sounds an octave high;
> and its channel-volume routine computes the scaled level of §4 correctly
> and then writes the *unscaled* one, so `An` and note-on velocities have no
> audible effect at all. Neither is a variant reading of the format.

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
value and write it back. Do *not* recompute the frequency here; only the key
bit changes.

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

IMPLAY's interpreter differs from this table in three places, none of them
audible on the corpus *(IMPLAY.EXE)*. A `9n` note-on does not key the voice
off first; FILE_FORMATS §1.4 counts where that could matter. Channels 9 and
10 in melodic mode are not filtered. The driver ignores them for patches and
volume, and their note-ons land on registers `0xA9`–`0xAA` and `0xB9`–`0xBA`, which the
chip does not have. And a song ends at `totalTick` as well as at `FC`
(FILE_FORMATS §1.5).

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

## 10. Four-operator voices (OPL3)

**This section and §11 are not AdLib's driver.** They describe the same
algorithm generalised to a YMF262, which `.ims` and `.rol` never ask for and
`.sop` needs (SOP_FORMAT.en.md §8). A YM3812 implementation can stop at §9.

A YMF262 is this machine twice over: the same nine channels, the same eighteen
operators, the same register numbers, at `reg | 0x100`. Everything in §1
through §9 applies unchanged to each bank. Voice *v* of the second bank uses
`opOffset(v − 9, o) + 0x100`, and its 0xA0/0xB0/0xC0 registers are
`0xA0 + (v − 9) + 0x100` and so on.

Two registers exist only in the second bank:

| Register | Bits | Meaning |
|---|---|---|
| 0x105 | 0 | **NEW.** Everything in §10 and §11 is ignored until this is set, including the second bank itself. |
| 0x104 | 0–5 | One bit per joinable channel pair, in the order below. |

**Set 0x105 first.** Writing the second bank before NEW does nothing at all,
so a reset that zeroes 0x000–0x1F5 must set NEW before it starts, not after.

### 10.1 Which pairs can be joined

Six, and only six — a channel and the one three above it, in the same bank:

| Bit of 0x104 | Channels |
|---|---|
| 0 | 0 and 3 |
| 1 | 1 and 4 |
| 2 | 2 and 5 |
| 3 | 9 and 12 |
| 4 | 10 and 13 |
| 5 | 11 and 14 |

The lower channel of a pair is its **head**: the joined voice is addressed by
the head's registers, and the upper channel — the **slave** — stops being a
voice of its own. Its key-on bit is not read, its F-number is not read, and it
produces no output; its two operators are read as operators 3 and 4 of the
head's voice. A player that allocates voices must therefore take the slave out
of circulation for as long as the pair is joined, or the notes it puts there
will vanish.

The rhythm mode is unaffected: it lives on channels 6, 7 and 8 of the first
bank, and none of those is in a pair.

### 10.2 The four connections

Each half keeps its own CNT bit in its own 0xC0. Reading CNT as *"this half's
first operator goes straight to the output instead of modulating"* gives all
four connections at once:

| CNT of head | CNT of slave | Connection |
|---|---|---|
| 0 | 0 | 1 → 2 → 3 → 4 |
| 0 | 1 | 1 → 2 → 3, and 4 |
| 1 | 0 | 1, and 2 → 3 → 4 |
| 1 | 1 | 1, and 2 → 3, and 4 |

Feedback belongs to operator 1 alone; the slave's feedback setting has nothing
to act on, because operator 3 is fed by the chain rather than by itself.

**§4's volume rule generalises through that table.** Channel volume scales the
operators that reach the output and leaves the ones that only modulate alone,
so it applies to operator 4 always, to operator 1 when the head's CNT is 1, to
operator 3 when the slave's CNT is 1, and to operator 2 never. Note that this
depends on *both* halves' CNT bits, so loading the first pair's levels before
the second pair's connection is known gets them wrong — send all four
operators' 0x40 again once both halves are in.

## 11. Stereo (OPL3)

Bits 4 and 5 of each channel's 0xC0 are output enables, not a pan knob: bit 4
routes the channel to the left output and bit 5 to the right. Both is centre.

**Neither is silence, and neither is where a YMF262 comes up.** A driver that
sets NEW and then never writes 0xC0 is mute. Write both bits on every channel
at reset; a driver that has no idea about panning then behaves exactly as it
did on a YM3812.

A joined pair (§10) is two channels, and the simplest thing that is always
right is to write the same two bits to both halves.

### 11.1 IMPLAY's stereo

IMPLAY makes stereo out of an OPL3 without using a single four-operator
voice or pan bit per note *(IMPLAY.EXE)*. It plays **every melodic voice
twice**: once on each register bank, with identical patches and identical
frequency writes, keyed together. Bank 0's channel is routed to outputs B+D
(`0xC0` bits `0xA0`) and bank 1's to A+C (`0x50`). On a YMF262 as wired on a
Sound Blaster, A is left, so bank 0 is the right side and bank 1 the left.
The only difference between the two copies is their output level:

```
pan   = PAN[channel]                       // fixed, below; 0x40 is centre
right = left = volume                      // the 0..127 channel volume
if pan < 0x40:  right -= (0x40 - pan) * volume >> 6
if pan > 0x40:  left  -= (pan - 0x40) * volume >> 6
```

`right` and `left` then go through §4 in place of `volume`, for bank 0 and
bank 1 respectively. A modulator's level is the same on both banks.

The pans are constants, set when a song loads and reapplied on every `Cn`.
The song has no say in them:

| channel | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `PAN` | `45` | `38` | `1F` | `12` | `53` | `6A` | `5C` | `3D` | `51` | `17` | `72` |

So channel 3 sits well to the left (right side at 18/64 of full), channel 5
well to the right, and channel 0 almost in the middle. In percussive mode
channels 6–10 are rhythm voices, and those entries go unused. Rhythm mode
exists only on bank 0, so the bass drum and the four single-operator drums
play there alone. Their `0xC0` has all four output bits set (`0xF0`), and
they get the plain unpanned volume: the drums are centred. The key-shift
feature (a per-channel transpose) is applied to these voices too.

That is IMPLAY's stereo mode, used when it finds an OPL3 or a Sound Blaster
Pro, and reported as "STEREO". Otherwise it plays mono on one OPL2. The
driver also has a third mode that sends everything to both banks, rhythm
section included, as two separate OPL2 chips would need. Nothing in IMPLAY
3.1 ever selects it.

## 12. Emulation notes

These files were written for a real YM3812 at 3.579545 MHz. Anything that
implements the register set faithfully will do; the format makes no use of
timers, no use of the 0x08 note-select bit, and no use of AM/vibrato depth.
Wave select is used, so an OPL1-only emulation (sine only) will sound wrong on
a large fraction of the corpus.

A YMF262 plays them too, and plays them identically, because it comes up as a
YM3812 and stays one until 0x105 says otherwise. That is worth testing rather
than assuming: `test/opl3.test.js` renders the same song on both and compares
sample for sample.

## 13. IMPLAY's playback controls

IMPLAY 3.1 lets the listener change three things while a song plays: how fast,
in what key, and where *(IMPLAY.EXE)*. None of them touches the file.

**Speed.** One word holds it, in half-percent steps: 200 is the song as
written. `>` (or `.`) adds 10, five per cent, while the value is 790 or less,
so it tops out at 800, four times as fast; `<` (or `,`) takes 10 away while it
is 10 or more, so it can reach 0. The timer routine multiplies its interrupt
rate by the value and divides by 200, in integers, and when the result falls
below 19 interrupts a second it programs a PIT divisor of 0, which the PC reads
as 65536 -- the BIOS's 18.2 Hz. So 0% does not stop the song; it plays at
whatever 18.2 ticks a second amounts to. The panel shows the result as
`Tempo = %4ld` and `%3d%%`: the song's current tempo (as `F0` events have left
it) times the value over 200, and the value over 2, both in integer division
-- a 112 bpm song at 90% reads `Tempo = 100   90%`.

**Key.** Each of the eleven channels has its own shift, a signed word of
semitones, and the `8n`/`9n` handler adds it to the note number before keying
the voice (§8). A note already sounding keeps its pitch; the shift is heard
from the next note on that channel. `Ins` raises and `Del` lowers by one, on
every channel the listener has selected with the keys `1`…; the shift stops
at +24 and −24. `Tab` puts all eleven back to 0, selected or not. Nothing
exempts the rhythm channels, so in percussive mode the key moves the bass
drum and the tom -- and the snare, which follows the tom (§6).

**Seeking.** `Z` and `X` do not jump by a fixed amount. While one is held, a
cursor walks along the progress bar, one of its 584 positions per screen
repaint; when it is let go, IMPLAY seeks to `position × totalTick ÷ 584`
(`totalTick` is the header's, FILE_FORMATS §1.5). The seek itself:

1. Every voice is keyed off and set to volume 0.
2. If the target is behind the current tick, the song starts over from its
   first event, with the header's tempo.
3. Events up to the target are read by a second parser that records what each
   channel is left with -- patch, volume and bend -- without writing a
   register.
4. Each channel then gets its patch (the built-in default if the bank lacks
   it, §3), its volume and its bend.

Step 4 goes on to strike again any note still held, by the same flag the
panel's `P` reads -- but the parser in step 3 never sets that flag, and step 1
has just cleared it on every channel, so the branch never runs. After a seek
every voice is silent until the song next strikes it.

**The panel.** Each channel's row shows its instrument name, a `P` drawn in
one colour while the channel holds a note and another while it does not, and
its key shift; the rhythm channels' names are drawn in a colour of their own.
The bars above are not a level meter: each is the channel's last note-on
velocity, decaying, scaled by the mixer.

**This library** (`Sequencer.speed`, `transpose` and `seek`; `IyagiMusic`
wraps them) takes any positive speed and leaves the stepping to its caller.
Its key shift is added at note-on as IMPLAY's is, but only for the melodic
voices: moving the drums only detunes the kit. Its seek always starts over
and chases from the top, which lands in the same state as IMPLAY's forward
case, except that a note held across the target is heard: it was keyed
during the chase, and comes back from its attack -- what IMPLAY's step 4 was
evidently written to do. With the levels equalised, §11.1's doubled layout is
the YM3812's output sample for sample, which `test/controls.test.js` checks;
that is how the web player offers mono without reloading the song.
