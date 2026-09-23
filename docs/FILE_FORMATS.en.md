# Iyagi Music Sound — file format specification

Covers the four file types found alongside Korean AdLib music of the early
1990s BBS scene:

| Ext    | What it is                                             |
|--------|--------------------------------------------------------|
| `.ims` | Iyagi Music Sound — the song (AdLib MIDI + patch table) |
| `.bnk` | AdLib instrument bank — the patches the song names      |
| `.rol` | AdLib Visual Composer song — the ancestor format        |
| `.iss` | Iyagi Synced Script — timed lyrics for an `.ims`        |

All multi-byte integers are **little-endian**. All text is either 7-bit ASCII
or Korean 2-byte Johab; see `JOHAB_ENCODING.en.md`.

A fifth format, `.sop`, turns up in the same collections but belongs to a
different program and a different chip; it has its own document,
`SOP_FORMAT.en.md`.

This document was written from the publicly available format descriptions
(the ModdingWiki articles on *IMS Format*, *AdLib MIDI Format*, *ROL Format*,
*AdLib Instrument Bank Format*) and then **corrected and extended by measuring
a corpus of 1128 `.ims`, 450 `.bnk`, 680 `.iss` and 2 `.rol` files**. Every
claim marked *(measured)* was checked against every file in that corpus. One
question the files could not settle on their own — what a lyric highlight
actually looks like (§4.2) — was settled by watching Iyagi itself run under
DOSBox.
Where the wiki and the observed data disagree, the data wins and the
disagreement is called out.

---

## 1. IMS — the song file

An IMS file is an *AdLib MIDI* (a.k.a. `.mus`) song with a patch-name table
glued onto the end. Layout:

```
+0      IMS header            70 bytes
+70     MIDI event stream     dataSize bytes
+70+ds  patch table           4 + 9 * numInstruments bytes
```

### 1.1 Header (70 bytes)

| Off | Type      | Name          | Notes |
|-----|-----------|---------------|-------|
| 0   | `u8`      | majorVersion  | always 1 *(measured)* |
| 1   | `u8`      | minorVersion  | always 0 *(measured)* |
| 2   | `i32`     | tuneId        | always 0 *(measured)*; ignore |
| 6   | `char[30]`| tuneName      | song title, NUL-padded, Johab |
| 36  | `u8`      | tickBeat      | ticks per beat — always **240** *(measured)* |
| 37  | `u8`      | beatMeasure   | beats per measure (4 in 96% of files) |
| 38  | `i32`     | totalTick     | song length in ticks — **advisory only**, see §1.5 |
| 42  | `i32`     | dataSize      | length of the MIDI event stream |
| 46  | `i32`     | nrCommand     | event count — see §1.5 |
| 50  | `u8`      | srcTickBeat   | ticks per beat of the ROL this was converted from, or 0 if not recorded — §1.8 |
| 51  | `u8[7]`   | reserved      | usually zero; 3 files put values in bytes 54–57 |
| 58  | `u8`      | soundMode     | 0 = melodic (9 channels), 1 = percussive (11 channels) |
| 59  | `u8`      | pitchBRange   | pitch-bend range in semitones, 1–12; always 1 except 3 files that say 60 |
| 60  | `u16`     | basicTempo    | tempo in beats per minute |
| 62  | `u8[8]`   | reserved2     | always zero *(measured)* |

`tickBeat` being universally 240 is worth knowing: it means a `0xF8` delay
overflow (§1.3) is exactly one beat, and it means the tick grid is far finer
than the music actually uses (see §1.6).

> **Trap.** `soundMode` uses **0 = melodic**. The `.rol` field that means the
> same thing (`isMelodic`) is **inverted**: 1 = melodic. Converters that carry
> the byte across unchanged produce silent drums or drum-flavoured melodies.

### 1.2 MIDI event stream

The stream is standard MIDI *notation* but it is not a MIDI file: there is no
MTrk chunk, delays are plain bytes rather than variable-length quantities, and
several messages carry fewer data bytes than MIDI requires. It is also not
meant for a MIDI device — programme numbers index the song's own patch table.

Each event is:

```
<delay byte>* <status or running-status> <data bytes>
```

| Message      | Bytes    | Meaning |
|--------------|----------|---------|
| `8n nn vv`   | 2 data   | Note off / retrigger — see §1.4 |
| `9n nn vv`   | 2 data   | Note on; `vv == 0` means note off |
| `An vv`      | **1** data | Channel volume (0–127) |
| `Bn cc xx`   | 2 data   | Control change — ignored; **absent from the corpus** |
| `Cn ii`      | 1 data   | Patch change; `ii` indexes the patch table |
| `Dn xx`      | 1 data   | Channel aftertouch — ignored; **absent from the corpus** |
| `En ll mm`   | 2 data   | Pitch bend, 14-bit — see §1.4 |
| `F0 7F 00 ii ff F7` | — | Tempo multiplier — see §1.4 |
| `F0 .. F7`   | —        | Any other SysEx: skip to `F7`; **absent from the corpus** |
| `FC`         | —        | End of song |

Running status applies to `8n`–`En` exactly as in MIDI: a byte < 0x80 in the
status position re-uses the previous channel status. *(measured: 853 066
running-status events across the corpus.)*

`F0` and `FC` **leave running status alone**: the previous channel status stays
live across them. That is what IMPLAY does *(IMPLAY.EXE)* — its interpreter
stores a status byte as the running status only when it is not `F0`, `F8` or
`FC`. Of the two widely-circulated players, one agrees and the other overwrites
running status with the `F0`/`FC` byte. No corpus file can tell them apart,
because all 7394 tempo events are followed by an explicit status byte
*(measured)*. A reader should follow IMPLAY. A writer should still never carry
running status across a tempo event, because some players do not.

Tagged *(IMPLAY.EXE)*: read out of the disassembly of `IMPLAY.EXE` 3.1
(1993), the Korean player these files were made for and heard on. That is
the program's behaviour, not a measurement of the corpus.

`An` taking **one** data byte instead of MIDI's two is the single most
important deviation. Get it wrong and the stream desynchronises within a few
events. *(measured: 559 051 `An` events across 1128 files, all consistent
with one data byte.)*

### 1.3 Delays

Every event is preceded by at least one delay byte, in ticks.

- A byte of `0xF8` means "240 ticks" and is followed by another delay byte.
- Any other value 0x00–0xF7 is a literal tick count and ends the delay.
- Values 0xF9–0xFF never appear in the delay position *(measured)*.

So a delay of 500 ticks is `F8 F8 14`. The largest single literal seen in the
corpus is 235.

### 1.4 Message semantics

**Note on (`9n nn vv`).** `nn` is a MIDI note number, 60 = middle C. `vv` is
*not* a velocity — the format descends from ROL, which has no velocities. `vv`
sets the **channel volume** and then the note sounds. `vv == 0` is a note off
and leaves the channel volume alone.

IMPLAY does not key the voice off before a `9n` note-on *(IMPLAY.EXE)*. So a
note-on landing on a voice that is still sounding changes pitch without a new
attack. On real data this never comes up: across the corpus only 7 note-ons
land on a keyed voice, all in the three damaged files of §1.5 *(measured)*.

**Note off / retrigger (`8n nn vv`).** This is where the sources disagree.
The wiki says: stop the current note, then start `nn` if `vv > 0`. A
widely-circulated player instead always restarts the note. IMPLAY does what
the wiki says *(IMPLAY.EXE)*: note off, then, only if `vv > 0`, set the
volume and start `nn`. (A switch in IMPLAY, whose purpose has not been traced,
can force the plain note-off.) **The question is moot on real data** anyway: `vv` is
non-zero in all 3 131 803 `8n` events in the corpus *(measured)*. Implement
the guarded form.

**Volume (`An vv`).** 0–127, scales the patch's own output level. It applies
even while a note is sounding and even after the note has been released, which
is how these files do fades and swells.

**Patch change (`Cn ii`).** `ii` is an index into the file's patch table
(§1.6), *not* a General MIDI programme. Every file in the corpus begins with a
run of `Cn` events — one per channel — before any note. All `ii` values are
within the table *(measured)*.

A name the bank does not have is not silence in IMPLAY *(IMPLAY.EXE)*. The
voice gets one of the AdLib driver's built-in timbres instead: the piano for
a melodic voice, and in percussive mode the bass drum, snare, tom, cymbal or
hi-hat default for channels 6–10. The same happens to every voice when no
bank could be loaded at all. The piano is the driver's own, except that its
carrier attack is 13 where the driver has 15.

**Pitch bend (`En ll mm`).** Standard MIDI 7-bit packing:
`value = ll | (mm << 7)`, 0…16383, centre 8192. Both data bytes are always
7-bit clean *(measured)*, and the observed values cluster on
`round(8192 * k)` for the ROL pitch multipliers 0.8, 0.9, 1.0, 1.1 …, which
confirms the packing. A player that reads the two bytes as a little-endian
`u16` and halves it is off by up to 63/16383 of the bend range — audible only
as a fraction of a cent at the usual ±1-semitone range, but wrong.

**Tempo multiplier (`F0 7F 00 ii ff F7`).** Sets

```
tempo = basicTempo * (ii + ff / 128)
```

where `basicTempo` is the header field, not the current tempo — multipliers do
not compound. Every SysEx in the corpus is exactly this six-byte form
*(measured: 7394 events, no other SysEx shape)*.

**End (`FC`).** Exactly one per file, always the last event *(measured)*.

### 1.5 The two count fields, and how to distrust them

`nrCommand` counts **events plus `0xF8` delay-overflow bytes**. That is exact
for all 1128 files *(measured)* — the plain event count matches in only 89 of
them, so the wiki's "total number of MIDI events" is wrong.

`totalTick` is the sum of all delays in 904 of 1128 files. In the other 224 it
is **short** — sometimes drastically (one file claims 112 620 ticks against an
actual 211 540). The `FC` event is what ends the stream.

**IMPLAY stops at `totalTick` anyway** *(IMPLAY.EXE)*. Its interpreter adds
each delay to a tick counter and ends the song as soon as the counter reaches
`totalTick`, whether or not `FC` has come. It never recomputes the field on
load. So in the player these files were heard on, `totalTick` is where the
song ends, not a display hint. Over the grown corpus that matters for 315 of
1725 files, and for all but three of them it only trims silence. In the
other 312 the last note-on comes before `totalTick`, and what follows is a
silent tail before `FC`. Its median is 20 beats. `MM-RAIN.IMS` has about
23 700 beats of it, which is over three hours at its tempo *(measured, 1725)*.
The three exceptions are the damaged `SPRING.IMS` and `BT-REDMO.IMS` (below)
and `D-PRODC#.IMS`, whose `totalTick` of 57 840 falls at beat 241 of about
1070. It looked like the one intact song the rule would cut short, but
inspected by ear and by event, what lies past `totalTick` is a single
extremely drawn-out note on channel 5, not more of the song. Three more files
have a `totalTick` *longer* than their stream; there `FC` ends them first.

This library stops where IMPLAY does: at `totalTick`, or at `FC` if that comes
first. It used to play to `FC`, on the strength of `D-PRODC#.IMS`; with that
file accounted for, nothing in the corpus past `totalTick` is music, and
`test/player.test.js` pins the 316 files it trims -- the 314 above whose `FC`
comes later, and the two damaged ones that have no `FC` at all, which also end
at `totalTick`.

Likewise `dataSize` is authoritative for finding the patch table, but one
corpus file (`HB-NOTGO.IMS`) has 838 bytes of extra event data after its patch
table. Parse the table at `70 + dataSize` and stop; do not assume the file
ends there.

**Some files are damaged, and the counts are how to tell.** The corpus has
since grown to 1725 `.ims`, and four of them carry bytes no converter wrote
*(measured, 1725)*. `AUTUMN.IMS`, `MANDOL.IMS` and `SPRING.IMS`, which share a
1995-08-22 date, run sound for about a thousand events and then turn into
junk: status bytes like `FF`, data bytes with bit 7 set, delays out of any
grid — and the last two stop without an `FC`. `BT-REDMO.IMS` has a single bad
byte, a pitch-bend high byte of `0x9A`, and its `nrCommand` is off by exactly
one. A player should survive all four, and a measurement should leave them out:
§1.4's `FC`-is-last and 7-bit-bend claims hold for every other file.
Damage shows as a status byte above `F0` other than `FC`, a data byte of 0x80
or more, or a stream that does not end in `FC`. `nrCommand` is not the test,
and the exactness claimed for it above did not survive the larger corpus: it
also disagrees in three files whose streams are otherwise sound — by 18 in
`BALO.IMS`, 17 in `GUIL.IMS` and 3072 in `BRANDEN.IMS`.

### 1.6 Patch table

At offset `70 + dataSize`:

| Type       | Name            | Notes |
|------------|-----------------|-------|
| `char[2]`  | signature       | `"ww"` |
| `u16`      | numInstruments  | 2–63 in the corpus |
| `char[9] * numInstruments` | names | NUL-padded patch names |

Each name is looked up in a bank file (§2). The names are **not** patch data —
an IMS with no matching bank is unplayable.

> **Trap.** Lookup must be **case-insensitive**. IMS files store names in lower
> case; banks overwhelmingly store them in upper case. *(measured: exact
> matching resolves 11 067 of 37 747 references — 29% — while ASCII
> case-folded matching resolves 37 729, i.e. 99.95%.)*

Which bank: try `<songname>.bnk` beside the song first, then fall back to a
general bank (`STANDARD.BNK`). *(measured: 446 of 1128 songs ship a private
bank; the rest need the general one.)*

### 1.7 Channels

Channel numbers run 0–8 in melodic mode and 0–10 in percussive mode. 228
events in the corpus address channels 9 or 10 in a melodic-mode file; those
must be **discarded**, not clamped *(measured)*.

### 1.8 Timing

```
ticksPerSecond = tempo * tickBeat / 60
secondsPerTick = 60 / (tempo * tickBeat)
```

with `tempo` the current tempo after any multiplier. At the corpus-universal
`tickBeat = 240` and a typical 120 BPM this is 480 ticks per second.

Useful for anything that wants a note grid: the greatest common divisor of all
delta times in a file recovers the composer's original resolution, because the
AdLib ROL→MIDI converter rescales ROL ticks to 240 per beat. *(measured GCDs:
30 in 745 files (= 1/8 beat), 20 in 170 (= 1/12 beat, triplets), 60 in 109
(= 1/4 beat), 15 in 36, and every observed GCD divides 240.)*

`srcTickBeat` is that resolution stated outright, when the converter bothered
to record it. In all 59 files where it is non-zero, `240 / srcTickBeat` equals
the delta-time GCD **exactly** *(measured)* — which is both a confirmation of
the GCD rule and a free shortcut for the files that carry it. The other 1069
files leave it at zero and have to be measured.

---

## 2. BNK — the instrument bank

### 2.1 Header

| Off | Type      | Name           | Notes |
|-----|-----------|----------------|-------|
| 0   | `u8`      | verMajor       | always 1 *(measured)* |
| 1   | `u8`      | verMinor       | always 0 *(measured)* |
| 2   | `char[6]` | signature      | `"ADLIB-"` |
| 8   | `u16`     | numUsed        | records in use |
| 10  | `u16`     | numInstruments | records present |
| 12  | `u32`     | offsetName     | start of the name section |
| 16  | `u32`     | offsetData     | start of the patch section |

> **Trap.** The wiki shows an 8-byte pad after `offsetData`, making a 28-byte
> header. That pad is present in 445 of 450 corpus banks and **absent in 5** —
> including the widely distributed general bank, whose `offsetName` is 20.
> Always seek using `offsetName` / `offsetData`; never assume a fixed header
> size.

### 2.2 Name section — `numInstruments` records of 12 bytes, from `offsetName`

| Type      | Name  | Notes |
|-----------|-------|-------|
| `u16`     | index | index into the patch section |
| `u8`      | flags | 0 = record unused, non-zero = in use |
| `char[9]` | name  | NUL-padded |

`flags` is documented as 0 or 1 but also takes 2, 8, 9, 10 and 255 in the
corpus. Treat any non-zero value as "in use".

The patch record for a name lives at `offsetData + index * 30`. The `index`
field is usually just the record's ordinal, but it is the field, not the
ordinal, that is authoritative.

Records are supposed to be sorted by name; 412 of 450 corpus banks are, 38 are
not. Do not binary-search — build a hash map, folding case.

### 2.3 Patch section — `numInstruments` records of 30 bytes, from `offsetData`

| Off | Type       | Name         |
|-----|------------|--------------|
| 0   | `u8`       | iPercussive  |
| 1   | `u8`       | iVoiceNum    |
| 2   | `OPLREGS`  | modulator    |
| 15  | `OPLREGS`  | carrier      |
| 28  | `u8`       | modWaveSel   |
| 29  | `u8`       | carWaveSel   |

`OPLREGS` is 13 one-byte fields, in this order:

```
ksl  multiple  feedback  attack  sustain  eg  decay  release
totalLevel  am  vib  ksr  connection
```

Each field is one *parameter*, not a packed register — see
`ADLIB_ENGINE_SPEC.en.md` §3 for how they become OPL register writes. Values
must be masked to the width of their register field: corpus banks contain
values up to 255 in every one of the thirteen fields.

`iPercussive` and `iVoiceNum` are **not usable**. The official player ignores
them and decides melodic-vs-percussive purely from the channel the patch is
loaded onto; corpus values include 9, 11, 15 and 50, so they are not even a
reliable boolean.

Trailing slack after the patch section (35 of 450 banks) and a gap between the
name and patch sections (32 of 450) are both normal. Size the sections from
the header offsets and the record counts.

---

## 3. ROL — AdLib Visual Composer song

IMS descends from ROL by way of AdLib's own `convert.exe`. ROL is a
**track-per-parameter** format rather than an event stream: 45 fixed tracks,
laid out one after another with no offsets, so it must be parsed strictly in
order.

### 3.1 Header

| Off | Type        | Name         | Notes |
|-----|-------------|--------------|-------|
| 0   | `u16`       | majorVersion | 0 |
| 2   | `u16`       | minorVersion | 4 |
| 4   | `char[40]`  | signature    | nominally `\roll\default` — see below |
| 44  | `u16`       | tickBeat     | ticks per beat |
| 46  | `u16`       | beatMeasure  | beats per measure |
| 48  | `u16`       | scaleY       | editor zoom, ignore |
| 50  | `u16`       | scaleX       | editor zoom, ignore |
| 52  | `u8`        | reserved     | |
| 53  | `u8`        | isMelodic    | **1 = melodic, 0 = percussive** (inverted vs IMS) |
| 54  | `u16[45]`   | counters     | per-track event counts, see §3.3 |
| 144 | `u8[38]`    | filler       | |
| 182 | —           | tracks       | |

> The 40-byte `signature` is a free text field in practice. Both Korean ROLs
> examined carry a Johab-encoded song title and the arranger's handle there
> rather than `\roll\default`. A converter should read it as text, not check
> it as a magic number.

### 3.2 Tracks

One tempo track, then eleven groups of four tracks (voice, timbre, volume,
pitch) — 45 in total, present even when only 9 voices are in use.

**Tempo track**

```
char[15] name; f32 basicTempo; u16 nEvents;
{ u16 atTick; f32 multiplier } * nEvents
```

**Voice track** (one per voice)

```
char[15] name; u16 nTicks;
{ u16 note; u16 duration } *   // until the durations sum to nTicks
```

`note` is 0 for a rest, otherwise a MIDI note number (48 = middle C in AdLib's
own numbering; see the engine spec for the -12 transpose the driver applies).

**Timbre track**

```
char[15] name; u16 nEvents;
{ u16 atTick; char[9] instName; u8 filler; u16 unknown } * nEvents
```

`instName` names a patch in a `.bnk` (or a standalone `.ins`). `unknown` is
sometimes the bank index and cannot be relied on.

**Volume track**

```
char[15] name; u16 nEvents;
{ u16 atTick; f32 volume } * nEvents      // 0.0 … 1.0
```

**Pitch track**

```
char[15] name; u16 nEvents;
{ u16 atTick; f32 pitch } * nEvents       // 0.0 … 2.0, nominal 1.0
```

The pitch multiplier maps onto the IMS 14-bit bend as
`bend = round(8192 * pitch)`, which is exactly the relationship visible in
converted IMS files.

### 3.3 Counters

The 45 header counters are, in order: 11 voice-track tick totals, 11 timbre
event counts, 11 volume event counts, 11 pitch event counts, then the tempo
event count. They duplicate the per-track fields. In both corpus ROLs every
counter matches its track exactly, which makes them a cheap structural check —
but the per-track fields are what the tracks are actually sized by.

---

## 4. ISS — Iyagi Synced Script

Timed lyrics for karaoke-style display. Purely presentational; a player can
ignore it entirely.

### 4.1 Header (154 bytes)

| Off | Type       | Name       | Notes |
|-----|------------|------------|-------|
| 0   | `char[20]` | headStr    | `"IMPlay Song V2.0"`, `"…V2.1"`, or blank — decides the tick unit, §4.2 |
| 20  | `u8[10]`   | reserved   | |
| 30  | `char[30]` | writer     | lyricist, Johab |
| 60  | `char[30]` | composer   | Johab |
| 90  | `char[30]` | singer     | Johab |
| 120 | `char[30]` | editor     | who made the ISS, Johab |
| 150 | `u16`      | recCount   | |
| 152 | `u16`      | lineCount  | |

> **The four credit fields are not credits.** They are named for the lyricist,
> composer, singer and ISS author, and that is what the fields *mean* — but in
> the wild they hold whatever an ISS-authoring tool left in them. Across all
> 680 corpus files there are five distinct `writer` values and three each of
> the rest *(measured)*:
>
> | files | writer | composer | singer | editor |
> |---|---|---|---|---|
> | 214 | `WRITER` | `COMPOSER` | `SINGER` | `EDITOR` |
> | 323 | `LeeYS` ×305, `MunBK` ×17, `KimTH` ×1 | `Solgher` | `Damul` | `Salmosa` |
> | 143 | *(blank)* | *(blank)* | *(blank)* | *(blank)* |
>
> The first group is the field labels, untouched. The second is a tool's
> default handles, with only the first field ever edited — and edited to the
> ISS author's own handle rather than to the lyricist's. The clincher: across
> the 601 files that sit beside an `.ims`, **not one** credit string appears
> anywhere in that song's title *(measured)*, even though IMS titles routinely
> carry the artist. Do not present these as authorship. The song's own title
> field is the only attribution these files actually carry.
>
> The corpus has since grown to 1031 `.iss`, and the newcomers add three
> things *(measured, 1031)*. Five files of 1992–93 spell one phrase across the
> four fields — `This` / `is song` / `text` / `for IMP` — which is an older
> tool's default and is hidden the same way. Four files keep a picture's file
> name in the header: it starts at byte 26, inside `reserved`, and runs on
> into `writer`, which is why `writer` reads `G1.PCX`, `MOON.PCX`, `IRL.PCX`
> or `OVE.PCX` — the whole names are `XWING1.PCX`, `LEE_MOON.PCX`,
> `AIRGIRL.PCX` and `NO_LOVE.PCX`. And `GOODDAY.ISS` has lyric text where
> `headStr` and the credits should be.
>
> The `WRITER` / `COMPOSER` / `SINGER` / `EDITOR` labels come from IMPLAY
> itself *(IMPLAY.EXE)*. Its built-in lyric editor fills the four fields with
> exactly those strings when it starts a new file, and it has no way to type
> anything else into them.

**`headStr` is a version mark, and IMPLAY reads nothing else from it**
*(IMPLAY.EXE)*. IMPLAY 3.1's editor saves it as `sprintf("%-20s",
"IMPlay Song V2.0")`, space-padded to all twenty bytes with the terminating
NUL landing on byte 20. On load IMPLAY runs `strstr` for `IMPlay Song V`
over the header read as a C string, and uses the answer for one thing: the
unit of the tick field (§4.2). The corpus holds 850 `V2.0`, 17 `V2.1`,
163 blank headers and `GOODDAY.ISS` *(measured, 1031)*. The last two groups
are the older format. `GOODDAY.ISS`'s lyric text is harmless to IMPLAY,
because apart from that search it reads only the two counts at 150 and 152,
and for the credit display the four fields. Nothing in IMPLAY 3.1 reads bytes
20–29, so the `.PCX` names are not a backdrop *this* player shows. Whichever
tool wrote them, it was another one.

### 4.2 Highlight records — `recCount` * 5 bytes

| Type  | Name    | Notes |
|-------|---------|-------|
| `u16` | tick    | when to paint: song tick **÷ 8** in a V2 file, **÷ 10** in an old one |
| `u8`  | line    | script line index, 0-based |
| `u8`  | startX  | first character cell to paint, 0-based |
| `u8`  | widthX  | number of character cells to paint |

All three byte fields are **unsigned**. Read them as signed and 12 218 of the
corpus's records point at a negative line. *(measured.)*

**The tick unit depends on the header** *(IMPLAY.EXE)*. A file whose header
contains `IMPlay Song V` (§4.1) stores `tick / 8`. Any other file stores the
older unit, `tick / 10`, and IMPLAY converts it on load with integer
arithmetic, `stored * 10 / 8`, before multiplying by 8 like any V2 value.
Reading an old file as V2 runs its lyrics at four-fifths of the song's
pace. The corpus shows the same thing independently. Against the length of
their song, the old files' last records sit at a median 0.744 read as V2,
and 0.93 read as tenths, while the V2 files sit at 0.977 *(measured, 1031)*.
The largest stored value in an old file is 29 034, so the conversion never
overflows its sixteen bits.

**Records play in file order** *(IMPLAY.EXE)*. IMPLAY keeps an index into
the records and, while the clock has passed the indexed record's tick, paints
it and moves on. It never sorts. A record stored earlier than the one before
it therefore fires straight after that one, not at its own tick. That
affects 665 records in 103 files *(measured, 1031)*. Sorting on load, as this
section used to advise, moves them to where their tick says, which is not
where IMPLAY ever showed them.

**A record paints its own cells, and painted cells stay lit** *(IMPLAY.EXE)*.
Each record colours `[startX, startX + widthX)` on its line and nothing else.
The line is redrawn unlit, and painting starts over from the current record,
on exactly two occasions:

1. the record names a different line from the one showing, or
2. its `startX` is left of where the previous painted record ended.

```
if record.line != shown  or  record.startX < lastEnd:
    shown = record.line;  clear the line
paint record;  lastEnd = where it ended
```

So on an ordinary lyric line the records tile, rule 2 never fires, and what is
lit is the union of every record so far — the karaoke wipe. The gap between
one record's end and the next one's start is **0** in 168 527 corpus cases
and **1** — a space — in 75 582 *(measured)*. That is also why a line's first
record is often a wide one starting at column 0: it paints the indent.

The cells no record covers **never light**. `AGP-DEUX.ISS` line 18,
`둘러 싸여져 있는데 -- (워 - ----)`, has records for the syllables and the
dashes but none for the two parentheses, and IMPLAY leaves them unlit. Line
62, `F.o.n.y △ S.e.r.y`, has one record per letter, and only the eight
letters light. On screen that matters only for a non-space. IMPLAY colours
the text, not the cell, so an unlit space looks just like a lit one.

Rule 2 is what the same records use for animation. `AGP-DEUX.ISS` line 60, a
`D · E · U · X` banner, carries 691 records. Their start column keeps jumping
back — `24 29 34 39 · 23 39 36 34 31 29 26 24 · 23 39 …`. Each jump clears
the banner, so the light is a single mark that travels and flashes across the
letters, and now and then a spread of a few cells that sweeps to the right.
`ZAZA1.ISS` runs a light right to left through the letters of each word of
`IMS(ROL) Made By PIAZZA (NOW SV)` the same way. 168 corpus lines carry more
than sixty records and are doing this rather than singing.

This section used to describe records as the *right edge* of one growing
region, coloured from the leftmost column the line had reached:
`coloured = [ min(startX seen on this line), startX + widthX )`. It came from
the tiling statistics above, and was checked against Iyagi under DOSBox:
lyric lines fill left to right, and the banner travels rather than filling
once. Both observations still hold, and the rule above explains both. But
the old rule lights every gap between the first record and the current one —
the parentheses, the dots — and reads the banner as a volume bar, which is
not what IMPLAY draws.

The details of IMPLAY's painter *(IMPLAY.EXE)*:

- A record's span is clamped to the line's length, which is up to its first
  NUL. If `startX` falls on the second byte of a two-byte character, it moves
  on by one. The test is IMPLAY's own: an odd run of bytes ≥ 0x80 ending just
  before `startX`. The end is not adjusted.
- Leading spaces of the span are skipped. A span that is all spaces paints
  nothing, but still counts as the previous record for rule 2.
- `lastEnd` is where the painted span ended after clamping, and is 0 right
  after a clear.
- Records that come due in the same pass are one batch. Within a batch, rule
  2 compares against the state at the start of the batch, updated only by a
  clearing record. If a record in the batch clears, the records before it are
  never shown. Passes follow the clock, so only records sharing a tick are
  batched for certain.
- Before a new line's first record, when no record is due, IMPLAY shows that
  line early, unlit. It does this a quarter of the gap between the two
  records before the first record's tick, with the gap capped so that the
  line is never more than four beats early (`tickBeat` 240).

`resolveIssSpans()` in `src/formats.js` implements the rule. It batches only
records with the same tick, and reports a batch's final state for every
record in it.

### 4.3 Script lines — `lineCount` * 64 bytes

Fixed 64-byte NUL-padded text lines, Johab-encoded, laid out as text-mode
screen rows. Widths are in **character cells**: a Hangul syllable is two
cells, which is what `startX` and `widthX` count.

The general rule is by byte length, not by script — one byte is one cell, two
bytes are two — so every symbol, box-drawing character and Greek or Cyrillic
letter in the text is two cells as well. A reader holding decoded text rather
than the original bytes recovers this from the code point; JOHAB_ENCODING §6
gives the rule and the ways of getting it wrong.

`154 + 5 * recCount + 64 * lineCount` equals the file size exactly for all 680
corpus files *(measured)*.

Where IMPLAY puts a line on its normal screen, it keeps the file's own layout:
character cell `c` is drawn at column `c + 3`, eight pixels a column
*(IMPLAY.EXE)*. So the indentation in the file is the indentation on screen.
IMPLAY also has a second display, drawn at twelve pixels a cell, that ignores
it. There each line is centred on its visible text, using two bytes the loader
computes per line: the count of leading spaces, and half the width from the
first non-space to the last.
