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

This document was written from the publicly available format descriptions
(the ModdingWiki articles on *IMS Format*, *AdLib MIDI Format*, *ROL Format*,
*AdLib Instrument Bank Format*) and then **corrected and extended by measuring
a corpus of 1128 `.ims`, 450 `.bnk`, 680 `.iss` and 2 `.rol` files**. Every
claim marked *(measured)* was checked against every file in that corpus.
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

What `F0` and `FC` do to running status is **undetermined**. The two reference
players disagree — one leaves the previous channel status live, the other
overwrites it with the `F0`/`FC` byte — and no corpus file can tell them apart,
because all 7394 tempo events are followed by an explicit status byte
*(measured)*. Require an explicit status byte after `F0` and `FC`; a writer
must never carry running status across a tempo event.

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

**Note off / retrigger (`8n nn vv`).** This is where the sources disagree.
The wiki says: stop the current note, then start `nn` if `vv > 0`. A
widely-circulated player instead always restarts the note. **The question is
moot on real data**: `vv` is non-zero in all 3 131 803 `8n` events in the
corpus *(measured)*. Either reading reproduces every known file. Implement the
wiki's guarded form; it is the safer of the two.

**Volume (`An vv`).** 0–127, scales the patch's own output level. It applies
even while a note is sounding and even after the note has been released, which
is how these files do fades and swells.

**Patch change (`Cn ii`).** `ii` is an index into the file's patch table
(§1.6), *not* a General MIDI programme. Every file in the corpus begins with a
run of `Cn` events — one per channel — before any note. All `ii` values are
within the table *(measured)*.

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
actual 211 540). Treat it as a display hint. The `FC` event is what ends the
song.

Likewise `dataSize` is authoritative for finding the patch table, but one
corpus file (`HB-NOTGO.IMS`) has 838 bytes of extra event data after its patch
table. Parse the table at `70 + dataSize` and stop; do not assume the file
ends there.

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
| 0   | `char[20]` | headStr    | `"IMPlay Song V2.0"` (662 files) or `"…V2.1"` (15) |
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

### 4.2 Highlight records — `recCount` * 5 bytes

| Type  | Name    | Notes |
|-------|---------|-------|
| `u16` | tick8   | playback tick **divided by 8** |
| `u8`  | line    | script line index, 0-based |
| `u8`  | startX  | first character cell to colour, 0-based |
| `u8`  | widthX  | number of character cells to colour |

All three byte fields are **unsigned**. Read them as signed and 12 218 of the
corpus's records point at a negative line. *(measured.)*

`tick8` is non-decreasing in 590 of 680 files; sort defensively.

**A record is the right edge of the highlight, not the highlight.** The
coloured region runs from the leftmost column the line has reached so far up
to `startX + widthX`; everything to the right of that is uncoloured, and
moving to another line starts over. Colouring only `[startX, startX+widthX)`
in isolation lights one syllable at a time, which is not what these files
describe:

```
coloured = [ min(startX seen on this line), startX + widthX )
```

The evidence is in how the records tile. On an ordinary lyric line the gap
between one record's end and the next one's start is **0** in 168 527 corpus
cases and **1** — a space — in 75 582 *(measured)*, so the records abut and
the region grows a syllable at a time. That is the familiar karaoke wipe, and
it is why a line's first record is often a wide one starting at column 0: it
paints the indent so the wipe begins flush with the margin.

The same records get used for animation. `AGP-DEUX.ISS` line 60 — a `D · E ·
U · X` banner — carries 691 of them, and its right edge runs
`25 30 35 40 · 24 40 38 35 33 30 28 25 24 · 40 38 …`: a bar that shoots out
and drains back, three times over, then sweeps smoothly to the end. It reads
as a volume meter, which is exactly how it looks under Iyagi. 168 corpus lines
carry more than sixty records and are doing this rather than singing.

`resolveIssSpans()` in `src/formats.js` implements the rule.

### 4.3 Script lines — `lineCount` * 64 bytes

Fixed 64-byte NUL-padded text lines, Johab-encoded, laid out as text-mode
screen rows. Widths are in **character cells**: a Hangul syllable is two
cells, which is what `startX` and `widthX` count.

`154 + 5 * recCount + 64 * lineCount` equals the file size exactly for all 680
corpus files *(measured)*.
