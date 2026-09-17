# SOP — file format specification

`.sop` is the song format of a Korean OPL3 tracker of the mid-to-late 1990s,
found in the same BBS collections as `.ims`. The files themselves carry no tool
name and no byline — only the magic `sopepos`, which is a palindrome, and is
the only thing in the format that looks like a joke.

**Attribution, unverifiable.** The editor is reported as *Note Sequencer v1.0* by
**이호범**, © 1995, 1997; the ModdingWiki calls it *Note*. Neither could be
confirmed from the files nor was able to obtain the actual SOP editor,
none of which name a tool or an author, so it is recorded here as a report
rather than as a fact.

| | |
|---|---|
| Magic | `sopepos` at offset 0 |
| Version | 0.1, and only 0.1 |
| Chip | **YMF262 (OPL3)** — twenty voices, four-operator instruments, stereo |
| Integers | little-endian |
| Text | 7-bit ASCII, or Korean 2-byte Johab; see `JOHAB_ENCODING.en.md` |

It is not an Iyagi format and it is not an OPL2 format. It is documented here
because it travels with the corpus, because the library reads it, and because
§8 has to say out loud what is lost when an OPL2 plays one.

This document was written from the ModdingWiki article *SOP Format* and then
**checked against 336 `.sop` files**. A claim marked *(measured)* was verified
against all 336. Two other descriptions of the format exist and were **not** consulted —
a Vogons thread and SudoMaker's `adlib2vgm` — so where this document and those
differ, they were arrived at independently. The wiki's structure survived that
check completely: a reader written
strictly to it consumes all 336 files byte for byte, ending on the last byte of
every one, with no trailing slack anywhere *(measured)*. Six of its details did
not survive, and §7 lists them.

## 1. Header (76 bytes)

| Off | Type | Name | Notes |
|-----|------|------|-------|
| 0 | `char[7]` | signature | `sopepos` *(measured: 336/336)* |
| 7 | `u8` | majorVersion | always 0 *(measured)* |
| 8 | `u8` | minorVersion | always 1 *(measured)* |
| 9 | `u8` | padding | always 0 *(measured)* |
| 10 | `char[13]` | fileName | the name it was saved under — **not always its own**, see below |
| 23 | `char[31]` | title | NUL-padded; Johab in 80 of 336 files *(measured)* |
| 54 | `u8` | percussive | 0 = melodic, 1 = rhythm mode; 1 in 295 files, 0 in 41 *(measured)* |
| 55 | `u8` | padding | always 0 *(measured)* |
| 56 | `u8` | tickBeat | ticks per beat: 8, 12, 16, 4 or 6 *(measured)* |
| 57 | `u8` | padding | always 0 *(measured)* |
| 58 | `u8` | beatMeasure | beats per bar; 4 in 322 of 336 *(measured)* |
| 59 | `u8` | basicTempo | bpm; **120 in 335 of 336**, and 0 in the last one *(measured)* |
| 60 | `char[13]` | comment | unused — and uninitialised, see below |
| 73 | `u8` | nTracks | **always 20** *(measured)*; see §4.1 |
| 74 | `u8` | nInsts | instruments *and* comment lines; up to 128 *(measured)* |
| 75 | `u8` | padding | always 0 *(measured)* |

Everything after the header is positional — channel modes, instruments, twenty
tracks, control track, with no offset table anywhere — so a SOP has to be read
strictly in order, the way a ROL does. The compensation is that the file must
end exactly where the control track does, which is a strong check that nothing
was misread.

**`fileName` is a record of a save, not an identity.** `SV6-CHAN.SOP` says it
is `ID-WINT.SOP`. Do not use it to find anything.

**`comment` was never written to.** 110 of 336 files leave uninitialised stack
in it *(measured)* — fragments of earlier strings, including readable ones like
`OS1     D`. The four `padding` bytes, by contrast, really are zero in every
file, so a reader can check those and should ignore this. Neither is exposed by
`parseSop`.

**`basicTempo` is not the tempo.** The control track (§5) sets tempo, and
essentially always does so before anything sounds: of the 334 files with a
non-empty control track, every one carries at least one tempo event
*(measured)*. `basicTempo` only matters for the two files whose control track
is empty.

Ticks become seconds by the usual reading, `ticks per second = bpm × tickBeat ÷
60`, which is the same clock `Sequencer` already runs for IMS and ROL.

## 2. Channel modes — `u8[nTracks]`, at offset 76

One byte per track, saying what kind of voice it wants.

| Value | Meaning | Count *(measured)* |
|-------|---------|--------------------|
| 0 | unused channel | 229 |
| 1 | YMF262 four-operator | 229 |
| 2 | YM3812 two-operator | 6222 |
| **0x82** | **undocumented** — mode 2 with bit 7 set | 40 |

> **`0x82` is not in the published description.** It appears in four files —
> `CAPTAINH.SOP`, `CC-SMALL.SOP`, `MI-LOVE.SOP`, `MIR_TERA.SOP` — and only ever
> on mode 2, never on 0 or 1 *(measured)*. The tracks carrying it hold ordinary
> events: 24 810 of them across the four files, referencing ordinary
> instruments. So bit 7 is a flag on an otherwise normal two-operator channel,
> and a reader must mask it off rather than reject the file. What it means is
> **unknown**; "muted in the editor" is a guess and is not recorded here as
> anything else.

> **Mode 0 does not mean "no track".** 68 tracks marked 0 carry events
> *(measured)*, against 161 that are genuinely empty. Whether to play them is a
> player's decision, not a parser's.

## 3. Instruments — `nInsts` records, immediately after the mode table

### 3.1 Record

| Off | Type | Name |
|-----|------|------|
| 0 | `u8` | instType |
| 1 | `char[8]` | shortName — the bank instrument name |
| 9 | `char[19]` | longName — a display name |
| 28 | `u8[]` | packed register bytes, length by type |

| instType | Data | Meaning | Count *(measured)* |
|----------|------|---------|--------------------|
| 0 | 22 | melody, four-operator (OPL3) | 415 |
| 1 | 11 | melody, two-operator | 4498 |
| 6 | 11 | bass drum | 1540 |
| 7 | 11 | snare drum | 489 |
| 8 | 11 | tom tom | 455 |
| 9 | 11 | cymbal | 380 |
| 10 | 11 | hi-hat | 713 |
| 12 | 0 | not an instrument at all — a comment line, §6 | 11 393 |

Types 2, 3, 4, 5 and 11 do not occur *(measured)*; their sizes are therefore
unknown, and an unknown type has to be a parse error, because the record length
is the only thing that finds the next record.

`shortName` is `char[8]` with **no guaranteed terminator** — an eight-character
name fills it exactly. Both name fields are fixed-size buffers that the editor
reused without clearing, so stale text routinely runs on past the NUL:
`SNARESY.` / `SYNTH.SNARE\0sizi` is one record, where `sizing` is left over
from whatever was in the buffer before. Read to the first NUL and ignore the
rest.

### 3.2 Two-operator data (11 bytes)

Each byte is one OPL register value, already packed — unlike a `.bnk`, which
stores thirteen unpacked parameters per operator (`FILE_FORMATS.en.md` §2.3).

| Off | Name | Register | Field |
|-----|------|----------|-------|
| 0 | modChar | 0x20 | am, vib, eg, ksr, multiple |
| 1 | modScale | 0x40 | ksl, totalLevel |
| 2 | modAttack | 0x60 | attack, decay |
| 3 | modSustain | 0x80 | sustain, release |
| 4 | modWaveSel | 0xE0 | wave select |
| 5 | feedback | 0xC0 | feedback, connection |
| 6 | carChar | 0x23 | |
| 7 | carScale | 0x43 | |
| 8 | carAttack | 0x63 | |
| 9 | carSustain | 0x83 | |
| 10 | carWaveSel | 0xE3 | |

> **How much of this is real depends on the type.** Types 7–10 are the
> single-operator rhythm voices, and in those **everything from byte 5 onward
> is uninitialised**. Reading byte 4 as a wave select holds for every
> instrument of every type *(measured: 100% of 2037 rhythm instruments are in
> range 0–7)*, but byte 5 read as feedback/connection is in range for only
> 38.65% of snares, 51.43% of toms, 24.74% of cymbals and **18.79% of hi-hats**
> *(measured)* — against 100% of bass drums and 99.78% of two-operator
> melodies. That is exactly what the chip implies: register 0xC0 belongs to the
> channel, and the rhythm voices share channels, so a per-instrument feedback
> for a hi-hat has nowhere to go. **For types 7–10, only bytes 0–4 carry
> meaning.** The published description marks bytes 6–10 as melody-only but
> leaves byte 5 unqualified; see §7.

Wave selects use the OPL3 range 0–7. An OPL2 has four waveforms, so values 4–7
have no equivalent; `sopPatch` passes them through unchanged and the driver
masks them (§8).

### 3.3 Four-operator data (22 bytes)

The same eleven-byte layout twice: operators 1 and 2, then operators 3 and 4,
at register offsets 0x08/0x0B and with the second feedback byte at 0xC8.

This pairing is not a reading of the format so much as a fact about the bytes.
Across all 415 four-operator instruments, bytes 4, 10, 15 and 21 are **always**
in 0–7 and bytes 5 and 16 **always** in 0–15 *(measured)* — that is, every byte
the layout calls a wave select really is one, and every byte it calls
feedback/connection really is one, over 2490 bytes with no exceptions. The
layout is correct.

Four-operator instruments are used by 61 files, and 57 files mark at least one
channel mode 1 *(measured)*; tracks in mode 1 select a type-0 instrument 7145
times against 143 selections of anything else *(measured)*, so mode and
instrument type agree in practice.

## 4. Sequenced tracks

### 4.1 Track — `nTracks` of them, one after another

| Off | Type | Name |
|-----|------|------|
| 0 | `u16` | numEvents |
| 2 | `u32` | dataSize, in bytes |
| 6 | | `numEvents` events, `dataSize` bytes of them |

Both counts are redundant with walking the events, which is precisely why they
are worth checking: either one disagreeing means the walk lost alignment.

**`nTracks` is always 20, and the number is not arbitrary.** An OPL3 has 18
two-operator channels; in rhythm mode channels 6, 7 and 8 become the five
percussion voices, so the chip offers 15 melodic voices plus 5 rhythm ones —
twenty. The corpus confirms the slot assignment directly: in percussive files,
track slots 6, 7, 8, 9 and 10 select instTypes 6, 7, 8, 9 and 10 (bass drum,
snare, tom, cymbal, hi-hat) 62 508, 12 935, 18 357, 5932 and 90 036 times
respectively, against three-figure counts everywhere off that diagonal
*(measured)*.

### 4.2 Event

```
u16 deltaTicks    ticks since the previous event on this track
u8  code
... value bytes, by code
```

| Code | Name | Value | Count *(measured)* |
|------|------|-------|--------------------|
| 1 | special event | `u8` | **7** — see below |
| 2 | note on | `u8` pitch, `u16` length in ticks | 2 076 497 |
| 4 | volume | `u8`, 0–127 *(measured)* | 959 239 |
| 5 | pitch | `u8`, 0–200, centre 100 *(measured)* | 1 188 983 |
| 6 | instrument | `u8` index into §3 | 334 381 |
| 7 | panning | `u8`, 0 = right, 1 = middle, 2 = left | 114 619 |

No other code occurs *(measured)*.

**Note on** is the only event with more than one value byte, and it carries its
own length, so a note needs no matching note-off. Pitch runs 12–113 and length
1–1088 ticks *(measured)*.

**Pitch** is an unsigned byte about a centre of 100, i.e. −100…+100, spanning
one semitone either way. The measured range is exactly 0–200 with 100 by far
the commonest value *(measured)*, which is the published description confirmed
to the endpoint.

**Panning** is documented as 0/1/2 and is 0, 1 or 2 in 114 616 of 114 619
events. Three events say 7 or 9 *(measured)*, which is rare enough to be
corruption, but a parser should not assert on it. Which way round 0 and 2 are
cannot be settled from the files; the direction above is the wiki's and is
**not** independently verified here.

**The special event is not understood.** Seven occurrences in 2.08 million
events, across `AJH.SOP`, `HH-FF6.SOP`, `JAM777.SOP` and `MIR_BLUE.SOP`, with
values 0, 2, 100, 110, 120, 132 and 220 *(measured)*. Its one-byte size is
confirmed — the surrounding events stay aligned and the file still ends exactly
where it should — but nothing here says what it does.

**Instrument indices are not always valid.** 324 selections across 7 files name
an instrument the file does not have *(measured)*; `CH-LYCH.SOP` does it 303
times with 16 instruments, and `SV6-WHEN.SOP` asks for index 119 out of 20. A
player must survive it.

## 5. Control track — one, after the last sequenced track

Same layout as §4.1, but a **disjoint code space**:

| Code | Name | Value | Count *(measured)* |
|------|------|-------|--------------------|
| 3 | tempo | `u8` bpm, 2–255 *(measured)* | 2769 |
| 8 | global volume | `u8`, 0–127 *(measured)* | 14 775 |

Neither code ever appears in a sequenced track, and no sequenced-track code
ever appears here *(measured)*. The first control event is a global volume at
tick 0 in 228 files and a tempo at tick 0 in 97 *(measured)*.

Global volume scales every track's volume; it is how a SOP fades a whole song
at once.

The file ends with the control track. Nothing follows it in any of the 336
files *(measured)*.

## 6. Comments — instType 12

A type-12 record has no data bytes. Its `longName` holds one line of the song's
scrolling credits, **19 columns wide**, and they are stored in the instrument
table because that is where the editor had room for them. 11 393 of the corpus's
19 883 instrument records are comments *(measured)* — the credits are the bulk
of the table.

`shortName` is not used for them: the 727 type-12 records with a non-zero
`shortName` carry stale bytes from earlier records, not text *(measured)*. Read
`longName` only.

Unlike `.iss` lyrics, these are almost entirely ASCII — 10 of 11 393 contain a
byte ≥ 0x80 *(measured)* — but the ones that do are Johab, and `parseSop`
decodes them the same way it decodes the title.

## 7. Where the corpus and the published description disagree

The wiki's structure is right and its instrument layout is right. Six details
are not, and all six are things a player would hit:

1. **`chanMode` 0x82 is undocumented** (§2). Mask bit 7 off; do not reject.
2. **`iFeedback` is uninitialised for instTypes 7–10** (§3.2), not just the
   carrier fields the wiki qualifies. Only 18.79% of hi-hats have a usable
   value in it.
3. **Channel mode 0 does not mean the track is empty** (§2). 68 of them carry
   events.
4. **Panning is not always 0/1/2** (§4.2). Three events say 7 or 9.
5. **An instrument index can exceed `nInsts`** (§4.2), 324 times in 7 files.
6. **Value ranges were undocumented** and are now measured (§4.2, §5): volume
   and global volume 0–127, pitch 0–200, note 12–113, length 1–1088, tempo
   2–255.

Everything else the wiki says held: the 76-byte header, the positional layout,
the instrument sizes per type, the two- and four-operator byte orders, the
event codes and their value sizes, the disjoint control-track code space, and
the ±100 reading of pitch.

## 8. Playing a SOP on an OPL2

This library's chip is an OPL2. SOP is an OPL3 format. `sopSequence` bridges
them, and the bridge is lossy in four ways, all of them the chip's doing:

- **Voices.** SOP wants 20; an OPL2 has 9, or 6 plus the five rhythm voices.
  Only 38 of 336 files use nine or fewer melodic tracks, and 16 use six or
  fewer; **114 use all twenty** *(measured)*. Rhythm tracks 6–10 keep their
  voice one to one; melodic tracks share what is left, a voice allocated per
  note, and when all are busy the note that ends soonest is cut short.
- **Four-operator instruments.** Only the first operator pair is loaded (§3.3).
  61 files are affected *(measured)*.
- **Wave selects 4–7.** The driver masks them to the OPL2's four (`driver.js`
  `#sendWaveSelect`), so an OPL3 waveform becomes whichever of the first four
  shares its low two bits.
- **Panning.** Dropped. The chip is mono and this library has no stereo
  anywhere.

One thing the reduction adds rather than drops: a track that plays notes
without ever sending an instrument-select gets the first instrument in the
table that yields a patch. `ST-BGM.SOP` needs it — 4878 notes and not a single
event 6 *(measured)*, so it is relying on whatever the editor happened to have
loaded, and without a stand-in the whole file is silent.

Pitch and volume need no bridging: SOP's ±100 about 100 is exactly the driver's
14-bit bend at a pitch range of 1, and both volume scales are 0–127.

What comes out is the song as an OPL2 could have played it, which is not the
song. Anything wanting the real thing needs an OPL3 core, and this library does
not have one.
