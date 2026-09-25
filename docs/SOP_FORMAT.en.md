# SOP — file format specification

`.sop` is the song format of **Note**, a Korean OPL3 sequencer of the
mid-1990s, found in the same BBS collections as `.ims`. The files themselves
carry no tool name and no byline — only the magic `sopepos`, which is a
palindrome, and which turns out to be the author's HiTEL user ID.

**Attribution.** The program is *Note 1.0 Beta 2* by **이호범** (Lee Ho Bum),
© 1995, 1997; its title line reads `Note 1.0 Beta 2  Copyright (C) 1995,1997
Lee Ho Bum [sopepos]`, and its manual asks for bug reports to the HiTEL ID
`sopepos`. Earlier revisions of this document could only report the name
second-hand ("Note Sequencer v1.0"); the program itself has since been
recovered, and the name above is its own. Beta 2 is dated 1997.5 by its
update notes, and it is the version studied here. Two earlier betas (1995.2,
1995.3) are described in the same notes but were not available.

| | |
|---|---|
| Magic | `sopepos` at offset 0, seven bytes, no terminator |
| Version | 0.1, and only 0.1 |
| Chip | **YMF262 (OPL3)** — twenty voices, four-operator instruments, stereo |
| Integers | little-endian |
| Text | 7-bit ASCII, or Korean 2-byte Johab; see `JOHAB_ENCODING.en.md` |

It is not an Iyagi format and it is not an OPL2 format. It is documented here
because it travels with the corpus, because the library reads and plays it, and
because §8 has to say which chip it gets and what an OPL2 costs it.

## Sources, and how claims are marked

This document was first written from the ModdingWiki article *SOP Format* and
then **checked against 336 `.sop` files**. A claim marked *(measured)* was
verified against all 336. The wiki's structure survived that check completely:
a reader written strictly to it consumes every file byte for byte, ending on
the last byte of every one, with no trailing slack anywhere *(measured)*. Six
of its details did not survive, and §7 lists them.

It was then **corrected against the program that wrote the files**: the
32-bit LE executable inside Note 1.0 Beta 2's `NOTE.EXE` (a PMODE/W program),
disassembled. A claim marked *(NOTE.EXE)* is a reading of that code — what
Note's own loader, saver, editor or player does — and is the strongest
evidence this document has, because every file in the corpus was written by
some version of it. Where the code and an earlier *(measured)* inference
disagree, the section says so rather than quietly picking one.

The corpus has grown since the first measurement, to **347** `.sop` files.
Counts taken for the NOTE.EXE revision say *(measured, 347)*; the older
*(measured)* counts are over the original 336 and have not all been re-taken.

A second program was disassembled later: `HTS.EXE` 1.23, 박진홍's SOP player
of 1996–97, which also shows lyrics. A claim marked *(HTS.EXE)* is a reading
of its code. It is evidence about what that player does, not about what Note
wrote.

Other descriptions of the format: a memo by 박진홍 (Park Jin-hong), written for
his `ADLIB262` replay library and corrected by the author of Note himself,
according to its own preface; it is almost certainly the ancestor of the wiki
article, and it is cited below where it matters. A Vogons thread and
SudoMaker's `adlib2vgm` were **not** consulted.

## 1. Header (76 bytes)

Note builds the header and the channel-mode table (§2) as **one 96-byte
block**, reads it back as one, and writes it with a single call
*(NOTE.EXE)*. The split at 76 is this document's, not the program's.

| Off | Type | Name | Notes |
|-----|------|------|-------|
| 0 | `char[7]` | signature | `sopepos` *(measured: 336/336)* |
| 7 | `u8` | majorVersion | always 0 *(measured)* |
| 8 | `u8` | minorVersion | always 1 *(measured)* |
| 9 | `u8` | padding | always 0 *(measured)* |
| 10 | `char[13]` | fileName | the name it was saved under — **not always its own**, see below |
| 23 | `char[31]` | title | NUL-terminated, at most 30 characters; Johab in 80 of 336 files *(measured)* |
| 54 | `u16` | percussive | 0 = melodic, 1 = rhythm mode; 1 in 306 files, 0 in 41 *(measured, 347)* |
| 56 | `u16` | tickBeat | ticks per beat: 8, 12, 16, 4 or 6 *(measured)*; see below |
| 58 | `u8` | beatMeasure | beats per bar; 4 in 322 of 336 *(measured)* |
| 59 | `u16` | basicTempo | **always written as 120 and never read** *(NOTE.EXE)*; see below |
| 61 | `u8[12]` | — | never written — stale bytes, see below |
| 73 | `u8` | nTracks | **always 20** *(measured)*; see §4.1 |
| 74 | `u16` | nInsts | instruments *and* comment lines; up to 128 *(measured)* |

**The magic is seven bytes, and bytes 7–9 are three separate fields.** Note
copies exactly seven characters and then stores 0, 1 and 0 into bytes 7, 8 and
9 with three single-byte writes *(NOTE.EXE)* — not an eight-byte `"sopepos\0"`.
So `sopepos` has no terminator, and 0/1 is a version, 0.1. The loader compares
the seven bytes and **never looks at bytes 7–9**: it has no version check at
all *(NOTE.EXE)*. HTS, the lyric-capable SOP player (§8), does check. Bytes 7
and 8 must be 0 and 1, and it refuses anything else with "이 프로그램은 SOP
0.1판만 연주할 수 있습니다" (this program plays only SOP 0.1) *(HTS.EXE)*.

**Widths.** Earlier revisions split offsets 54, 56 and 74 into a `u8` and a
padding byte, which matched the data; the code settles it. `percussive`,
`tickBeat` and `nInsts` are written as 16-bit values from 8-bit variables, so
their high bytes are always 0, and the loader reads only the low bytes
*(NOTE.EXE)*. `basicTempo` is a 16-bit write of the constant 120 at the odd
offset 59 — which is why byte 60, once thought to open a comment field, is 0 in
all 347 files *(measured, 347)*: it is the tempo's high byte.

**`fileName` is a record of a save, not an identity.** Note forces byte 22 to
NUL — twelve characters of DOS 8.3 name — and fills the field from its own
save prompt, appending `.SOP` when the typed name has no dot *(NOTE.EXE)*. A
file renamed afterwards keeps the old name: `SV6-CHAN.SOP` says it is
`ID-WINT.SOP`. Do not use it to find anything.

**`title`** is forced NUL at byte 53, so it holds at most 30 characters
*(NOTE.EXE)*, matching the manual's "30자까지". Note cannot type Hangul — the
program has no Korean input or display — so the Johab titles were either typed
elsewhere or brought in by importing an `.ims`, whose title Note copies across
(§9).

**`tickBeat`** is chosen in the editor's *Ticks Per Beat* option, which accepts
4–24 *(NOTE.EXE)*. Changing it rewrites every event in the song (§9), which is
why the manual warns of rounding error. The five values in the corpus are the
values Note's IMS importer picks (§9).

**`beatMeasure`** is 1–24 in the editor *(NOTE.EXE)*; changing it only changes
where the bar lines are drawn.

**`basicTempo` is not the tempo.** Note writes 120 into it unconditionally and
never reads it back *(NOTE.EXE)*; a song starts at 120 bpm because that is the
player's default (§4.2), and the control track (§5) sets anything else. Of the
334 files with a non-empty control track, every one carries at least one tempo
event *(measured)*. The field matters only in the sense that a file saying
anything other than 120 was not saved by Beta 2: `GENETOWN.SOP` says 0, and
its whole run from byte 59 to 72 is zero *(measured, 347)*.

**Bytes 61–72 were never written to — by design of the program, not by
accident of the file.** Note keeps the header in one 96-byte heap block that is
allocated once at start-up and never cleared; loading a SOP copies all 96 bytes
of it into that block, and saving writes the block back after filling in only
the fields above *(NOTE.EXE)*. So these twelve bytes are whatever was in the
block: start-up garbage in the first file of a session, and after that
**inherited from whatever `.sop` was last loaded**. The corpus shows the
inheritance plainly — 183 files have non-zero bytes here, and they cluster by
author: all ten `DIN_*` files carry one identical twelve-byte value, the
`X-*` series and `BLESSING.SOP` another, six `MI-*` files a third, five `BIV_*`
a fourth *(measured, 347)*. Several of the values are recognisably 16-bit x86
code, which is what reused DOS memory would contain. An earlier count here, 110
of 336, could not be reproduced by this revision. `parseSop` exposes none of
it, and a writer should zero it.

**`nTracks` is written as the constant 20 and never read** *(NOTE.EXE)*: the
loader always reads twenty tracks and a control track.

Everything after the header is positional — channel modes, instruments, twenty
tracks, control track, with no offset table anywhere — so a SOP has to be read
strictly in order, the way a ROL does. The compensation is that the file must
end exactly where the control track does, which is a strong check that nothing
was misread.

Ticks become seconds by the usual reading, `ticks per second = bpm × tickBeat ÷
60`, which is the same clock `Sequencer` already runs for IMS and ROL. How Note
itself realises that clock is §5.

## 2. Channel modes — `u8[20]`, at offset 76

One byte per track, saying what kind of voice it is. The low seven bits are
the mode; bit 7 is a separate flag.

| Value | Meaning | Count *(measured, 347)* |
|-------|---------|--------------------|
| 0 | the upper half of a four-operator pair — see below | 249 |
| 1 | YMF262 four-operator | 249 |
| 2 | YM3812 two-operator | 6402 |
| bit 7 | **channel disabled in the editor** *(NOTE.EXE)* | 40, all on mode 2 |

**Bit 7 is the editor's "연주 불가능" (do not play) switch.** Alt-F1…F10 and
Shift-F1…F10 toggle it per track, and the solo key `/` sets it on every track
but the current one *(NOTE.EXE)*. Note's player skips a track with it set, and
its block operations skip it too — exactly as the manual says. It is saved
because the saver writes the mode byte as it stands. The four files that carry
it show both uses: `CAPTAINH.SOP` and `MI-LOVE.SOP` have it on **every track
but one** — they were saved with solo engaged — while `CC-SMALL.SOP` disables
one track and `MIR_TERA.SOP` one empty track *(measured, 347)*. It is view
state, not composition: a player should mask it off and play the track. Earlier
revisions called this value "undocumented, meaning unknown".

**Mode 0 is not "unused".** New songs start with every track at mode 2, and
the only thing that makes a 0 is Alt-F: making track *k* four-operator (only
tracks 0, 1, 2, 11, 12, 13 may be — the YMF262's pair heads) sets track *k*+3 to
mode 0, and making it two-operator again sets *k*+3 back to 2 with its bit 7
kept *(NOTE.EXE)*. The corpus agrees without exception: every one of the 249
mode-0 tracks is the +3 partner of a mode-1 track, and every mode-1 track sits
on a legal head *(measured, 347)*. The partner's events are **kept but not
played** — Note's player skips mode-0 tracks *(NOTE.EXE)* — so they are dormant
data from before the pair was joined. Six such tracks still hold notes, 51 of
them across three files *(measured, 347)*.

## 3. Instruments — `nInsts` records, immediately after the mode table

### 3.1 Record

| Off | Type | Name |
|-----|------|------|
| 0 | `u8` | instType |
| 1 | `char[8]` | shortName — the instrument's file name |
| 9 | `char[19]` | longName — a display name |
| 28 | `u8[]` | packed register bytes, length by type |

**The record is also a file format.** Note's single-instrument file, `.2IM`, is
exactly one of these records and nothing else; its file name is `shortName`
plus `.2IM` *(NOTE.EXE)*. That is what `shortName` is — an eight-character DOS
base name, which is why it has no guaranteed terminator (an eight-character
name fills it exactly). §3.4 has the set file.

Note knows more instrument types than the corpus uses. Its loader and saver
have a record size for exactly these *(NOTE.EXE)*:

| instType | Data | Label | Meaning | Count *(measured, 347)* |
|----------|------|-------|---------|--------------------|
| 0 | 22 | `4OP` | melody, four-operator (OPL3) | 608 |
| 1 | 11 | `2OP` | melody, two-operator | 4577 |
| 2 | 11 | `1OP` | melody, loaded exactly like type 1 — see below | 0 |
| 6 | 11 | `BDR` | bass drum | 1586 |
| 7 | 11 | `SDR` | snare drum | 509 |
| 8 | 11 | `TOM` | tom tom | 462 |
| 9 | 11 | `CYM` | cymbal | 397 |
| 10 | 11 | `HIH` | hi-hat | 747 |
| 12 | 0 | `---` | an empty slot — §6 | 12 030 |

The label is what the instrument box shows between the two names
*(NOTE.EXE)*. Beyond these, the label table names type **11 `PCM`** and leaves
types 3, 4 and 5 blank, but none of the four has a record size: Note's reader
reads no data bytes for them and its writer writes **no record at all**, while
still counting it in `nInsts` *(NOTE.EXE)*. A file holding one could not have
come out of Note intact, so an unknown type is still a parse error.

Type 2 is a real type with nowhere to come from. Note's instrument loader
treats it exactly as type 1 *(NOTE.EXE)*; what "1OP" was meant to mean is not
recorded anywhere this study could find. Note cannot create instruments at all
— it has no instrument editor — so every type arrives from a file: importing
from a `.bnk` yields type 1 for a melodic voice and the voice number 6–10 for a
percussive one *(NOTE.EXE)*, and types 0 and 2 can only come from `.2IM` files
made by the companion editor *262InsMaker* (not recovered), which the manual
names.

**The "N" labels.** Beta 2's update notes say instruments usable only on the
262 chip are shown as `2ON`, `BDN`, `SDN`, `TMN`, `CYN`, `HHN`. The rule is: a
type-1 or type-6 instrument whose modulator *or* carrier wave select is 4–7, or
a type 2, 7, 8, 9 or 10 whose modulator wave select is, gets the label twelve
places on (`2ON`, `1ON`, `BDN`, `SDN`, `TMN`, `CYN`, `HHN`) *(NOTE.EXE)*. It is
a display label only; the stored type does not change.

Both name fields are fixed-size buffers that the editor reused without
clearing, so stale text routinely runs on past the NUL: `SNARESY.` /
`SYNTH.SNARE\0sizi` is one record, where `sizing` is left over from whatever
was in the buffer before. Read to the first NUL and ignore the rest.

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

When Note imports from a `.bnk` it packs the thirteen parameters into these
bytes and sets byte 5 to `feedback × 2 + (connection == 0 ? 1 : 0)` from the
modulator's fields — the bank's connection flag is inverted on the way in
*(NOTE.EXE)*.

> **How much of this is real depends on the track, not only the type.** In
> rhythm mode, Note loads *any* instrument on the snare, tom, cymbal or hi-hat
> track (§4.1 slots 7–10) as a single operator: bytes 0–4, into that drum's
> operator slot *(NOTE.EXE)*. Bytes 6–10 are never used there. Byte 5 is used
> on exactly two of the four — on the **hi-hat** track its low four bits go to
> register 0xC7, and on the **tom** track to 0xC8; on the snare and cymbal
> tracks it is never written *(NOTE.EXE)*. That is chip-correct: the hi-hat and
> the tom are the modulator slots of channels 7 and 8, where feedback applies.
> The bass drum track loads a full two-operator voice.
>
> The corpus fits this. Reading byte 4 as a wave select holds for every
> instrument of every type *(measured: 100% of 2037 rhythm instruments are in
> range 0–7)*, while byte 5 read as a whole feedback/connection byte is in
> range for only 38.65% of snares, 51.43% of toms, 24.74% of cymbals and 18.79%
> of hi-hats *(measured)* — against 100% of bass drums and 99.78% of two-operator
> melodies. For snares and cymbals nothing reads it, so it can be anything; for
> hi-hats and toms Note masks it to four bits before writing, so the high bits
> are ignored. An earlier revision concluded that byte 5 carries no meaning for
> types 7–10; that holds for the snare and cymbal only.

Wave selects use the OPL3 range 0–7. An OPL2 has four waveforms, so values 4–7
have no equivalent there; `sopPatch` passes them through unchanged, and the
driver masks them only when the chip under it is an OPL2 (§8).

### 3.3 Four-operator data (22 bytes)

The same eleven-byte layout twice: operators 1 and 2, then operators 3 and 4,
at register offsets 0x08/0x0B and with the second feedback byte at 0xC8.

This pairing is not a reading of the format so much as a fact about the bytes.
Across all 608 four-operator instruments, bytes 4, 10, 15 and 21 are **always**
in 0–7 and bytes 5 and 16 **always** in 0–15 *(measured, 347)* — that is, every
byte the layout calls a wave select really is one, and every byte it calls
feedback/connection really is one, over 3648 bytes with no exceptions. The
layout is correct, and it is how Note loads it: one of four routines chosen by
the connection bits of bytes 5 and 16 *(NOTE.EXE)*, which decide which of the
four operators channel volume scales.

Four-operator instruments are used by 61 files, and 57 files mark at least one
channel mode 1 *(measured)*; tracks in mode 1 select a type-0 instrument 7145
times against 143 selections of anything else *(measured)*, so mode and
instrument type agree in practice. When they do not, Note does not reconcile
them: a type-0 instrument on a two-operator channel loads **its first pair
only**, as a two-operator voice *(NOTE.EXE)*, and a two-operator instrument on
a four-operator channel loads into the first pair and leaves the second as it
was — the manual's "may not work properly".

### 3.4 Instrument sets — `.2IS`

Beta 2 added saving and loading the whole instrument box as a set
*(NOTE.EXE; update notes)*. The file is a 48-byte header followed by records
exactly as in §3.1:

| Off | Type | Name | Notes |
|-----|------|------|-------|
| 0 | `char[10]` | signature | `262InsSet` and a NUL; the loader compares it as a string |
| 10 | `char[30]` | setName | zero-filled, at most 29 characters |
| 40 | `u16` | count | records that follow |
| 42 | `u8[6]` | — | never written (uninitialised stack) |

Loading a set replaces the instrument box and sets `nInsts` to `count`
*(NOTE.EXE)*. None of this is in the song file; it is recorded here because
`.2IM` and `.2IS` are the other half of the format family, and a SOP's
instrument table is nothing but an inlined `.2IS` body.

## 4. Sequenced tracks

### 4.1 Track — twenty of them, one after another

| Off | Type | Name |
|-----|------|------|
| 0 | `u16` | numEvents |
| 2 | `u32` | dataSize, in bytes |
| 6 | | `numEvents` events, `dataSize` bytes of them |

Both counts are redundant with walking the events, which is precisely why they
are worth checking: either one disagreeing means the walk lost alignment. Note
itself reads `numEvents` and discards `dataSize` *(NOTE.EXE)*.

**There are always twenty, and the number is not arbitrary.** An OPL3 has 18
two-operator channels; in rhythm mode channels 6, 7 and 8 become the five
percussion voices, so the chip offers 15 melodic voices plus 5 rhythm ones —
twenty. In Note **a track is a channel**, with no allocation between them
*(NOTE.EXE)*:

| Track | Chip channel |
|-------|--------------|
| 0–5 | first register bank, channels 0–5 |
| 6, 7, 8 | first bank, channels 6–8 — or, in rhythm mode, bass drum, snare, tom |
| 9, 10 | rhythm mode only: cymbal, hi-hat |
| 11–19 | second register bank, channels 0–8 |

Without rhythm mode tracks 9 and 10 do nothing — the manual's "18-channel
melody mode". The corpus confirms the rhythm slots directly: in percussive
files, track slots 6, 7, 8, 9 and 10 select instTypes 6, 7, 8, 9 and 10 (bass
drum, snare, tom, cymbal, hi-hat) 62 508, 12 935, 18 357, 5932 and 90 036 times
respectively, against three-figure counts everywhere off that diagonal
*(measured)*.

### 4.2 Event

```
u16 deltaTicks    ticks since the previous event on this track
u8  code
... value bytes, by code
```

| Code | Name | Value | Count *(measured, 347)* | Default *(NOTE.EXE)* |
|------|------|-------|--------------------|----------------------|
| 1 | special event | `u8` | **7** — see below | 0 |
| 2 | note on | `u8` pitch, `u16` length in ticks | 2 162 144 | — |
| 4 | volume | `u8`, 0–127 *(measured)* | 979 055 | **96** |
| 5 | pitch | `u8`, 0–200, centre 100 *(measured)* | 1 248 948 | 100 |
| 6 | instrument | `u8` index into §3 | 346 756 | 0 |
| 7 | panning | `u8`, 0 = right, 1 = middle, 2 = left | 119 306 | 1 |

No other code occurs *(measured)*. Note keeps events in memory as a list of
the same deltas, and its reader, meeting a code outside 1–8, reads no value
bytes for it and carries on *(NOTE.EXE)* — so an unknown code loses alignment
silently there, and is a parse error here.

**Defaults.** The last column is what Note's player assumes for a track that
has not yet had an event of that kind *(NOTE.EXE)*. The one that matters is
**volume: 96, not 127**. Channel volume maps onto the operators' total level
linearly in decibels (§8), so 96 is 12 dB below full; 254 tracks in 46 files
play notes before their first volume event *(measured, 347)*, and in Note they
are that much quieter than a player defaulting to 127 makes them. Instrument
defaults to slot 0, whatever is in it.

**Note on** is the only event with more than one value byte, and it carries its
own length, so a note needs no matching note-off. Pitch runs 12–113 and length
1–1088 ticks *(measured)*. Pitch is a MIDI-style note number, 60 = middle C: the
IMS importer copies the MIDI note number straight across, and the driver
subtracts 12 and clamps to 0–95 before looking up block and F-number
*(NOTE.EXE)*. So Note can sound nothing above pitch 107, and the 18 notes above
it — all in `ST-BGM.SOP` — play as 107 there *(measured, 347)*.

**Overlapping notes slur.** A note that starts while the track's previous note
is still sounding does not restart it: Note rewrites the frequency with the
key held down, and the new note's length replaces the old one's *(NOTE.EXE)*.
This is a feature — the manual draws it and says the first note "does not end;
only its pitch changes, for a smooth progression". A note that starts exactly
where the previous one ends is a fresh note: the key-off is processed before
the key-on at the same tick *(NOTE.EXE)*. Of consecutive note pairs in the
corpus, 908 740 touch and **133 575 overlap, in 284 of 347 files**
*(measured, 347)*. On a rhythm-mode drum track an overlapping note does not
strike again at all, because the drum's bit is already set; that is 29 794
overlaps, 27 536 of them on the bass drum *(measured, 347)*.

**Pitch** is an unsigned byte about a centre of 100, i.e. −100…+100, spanning
one semitone either way. The measured range is exactly 0–200 with 100 by far
the commonest value *(measured)*, which is the published description confirmed
to the endpoint. Note clamps it at 200 and uses `pitch >> 2`, so it plays only
51 distinct bends, 1/25 semitone apart — the classic AdLib driver's table
*(NOTE.EXE)*. More than half the corpus's pitch events are not multiples of 4
*(measured, 347)*; most come from IMS imports (§9), and Note rounds them down.
In rhythm mode pitch has no effect on the snare, tom, cymbal or hi-hat tracks
*(NOTE.EXE)*.

**Instrument** selects a slot of the instrument box, which always has 128. A
slot that holds nothing (type 12) loads nothing, so the previous instrument
keeps sounding *(NOTE.EXE)*. **Instrument indices are not always below
`nInsts`.** 324 selections across 7 files name a slot past the end of the
table *(measured)*; `CH-LYCH.SOP` does it 303 times with 16 instruments, and
`SV6-WHEN.SOP` asks for index 119 out of 20. In Note those are empty slots, so
they are harmless; none reaches 128 *(measured, 347)*.

**Panning** is documented as 0/1/2 and is 0, 1 or 2 in all but a handful of
events. Note turns 0, 1 and 2 into the OPL3's channel output bits 0x20, 0x30
and 0x10 — output B only, both, output A only — and the manual agrees that 0 is
right and 2 is left, which fixes the direction on a card that wires A to the
left *(NOTE.EXE)*. **Any other value is written into the register raw**, which
clears both output bits and silences the channel until the next pan event
*(NOTE.EXE)*. The corpus has five such events *(measured, 347)*: `MIR_FEEL.SOP`
and its twin `ST_FEEL.SOP` put a 7 inside an auto-pan sweep on two tracks,
three ticks of silence each; `V_1.SOP` sets track 19 to 9 at tick 0 and never
pans it again, so in Note on an OPL3 that track **never sounds**.

**The special event does nothing in Note's player** *(NOTE.EXE)*. It is stored,
drawn and edited as a control lane, 0–255, and the manual says what it is for:
synchronising something else to the music from another program, "never used
in ordinary composition". Note's own playback skips it. Seven occurrences in
2.16 million events *(measured, 347)*, across `AJH.SOP`, `HH-FF6.SOP`, `JAM777.SOP` and
`MIR_BLUE.SOP`, with values 0, 2, 100, 110, 120, 132 and 220 *(measured)*; its
one-byte size is confirmed both by the code and by the surrounding events
staying aligned.

## 5. Control track — one, after the last sequenced track

Same layout as §4.1, but a **disjoint code space**:

| Code | Name | Value | Count *(measured, 347)* | Default *(NOTE.EXE)* |
|------|------|-------|--------------------|----------------------|
| 3 | tempo | `u8` bpm, 2–255 *(measured)* | 2851 | 120 |
| 8 | global volume | `u8`, 0–127 *(measured)* | 15 212 | 127 |

Neither code ever appears in a sequenced track, and no sequenced-track code
ever appears here *(measured)*. Note's player would honour a global volume on
any track, but a tempo only on this one *(NOTE.EXE)*. The first control event
is a global volume at tick 0 in 228 files and a tempo at tick 0 in 97
*(measured)*.

**Global volume** scales every track's volume, `volume × global ÷ 127` in
integers *(NOTE.EXE)*; it is how a SOP fades a whole song at once.

**Tempo** drives the PC timer. Note runs its interrupt at `4 × bpm` Hz — 240
interrupts per beat, whatever the song's `tickBeat` — and advances the song one
tick every `240 ÷ tickBeat` interrupts, in integers *(NOTE.EXE)*. Every
`tickBeat` in the corpus divides 240, so this is exact there. Two limits follow
from the hardware: a rate under 19 Hz leaves the timer at its 18.2 Hz default,
so **tempos 2–4 play too fast in Note**, and only `4OPDANCE.SOP` asks for them
*(measured, 347)*; and a `tickBeat` that does not divide 240, which the editor
allows, plays slightly fast.

HTS (§8) keeps time the same way, `4 × bpm` Hz and one tick every
`240 ÷ tickBeat` interrupts, but **starts a song at 255 bpm, not 120**. Its
rewind routine programs the timer with 255, and nothing puts 120 in its place
*(HTS.EXE)*. A song whose control track sets no tempo at tick 0 therefore
plays fast in HTS until its first tempo event. That is 15 files, and 5 of them
never set a tempo at all *(measured, 347)*. This library, like Note, starts
at 120.

The file ends with the control track. Nothing follows it in any of the 336
files *(measured)*.

## 6. Comments — instType 12

The instrument box always has 128 slots, and type 12 is how Note marks one as
holding no instrument *(NOTE.EXE)*. Three things make one:

- **An untouched slot.** Every slot starts zeroed, with type 12.
- **A deleted instrument.** `Del` changes the type byte to 12 and nothing
  else, so the names and the register bytes stay in memory *(NOTE.EXE)*; only
  the 28-byte head is saved.
- **A renamed slot.** Either name can be edited whether or not the slot holds
  an instrument.

`nInsts` is one past the highest slot anything has been loaded into — from a
`.2IM`, from a `.bnk` or as a set — and nothing lowers it: deleting does not,
and renaming does not raise it *(NOTE.EXE)*. So every slot below it is saved,
empty or not, and the scene used that: a type-12 record's `longName` holds one
line of the song's scrolling credits, **19 columns wide**, typed over an empty
or deleted slot. 12 030 of the corpus's 20 916 instrument records are type 12
*(measured, 347)* — the credits, and the gaps between instruments, are the bulk of
the table. 130 files end their table with type-12 records, 9142 of them, 1370
with text *(measured, 347)*.

Because deletion keeps the names, a type-12 `longName` is not always a credit —
it can be the name of an instrument that was deleted and never overwritten.
`shortName` is not used for credits: the 727 type-12 records with a non-zero
`shortName` carry the file names of deleted instruments or other stale bytes,
not text *(measured)*. Read `longName` only.

Unlike `.iss` lyrics, these are almost entirely ASCII — 14 of 12 030 have a
byte ≥ 0x80 anywhere in the field *(measured, 347)* — which is what a program with no Hangul input would
leave. The ones that do are Johab, and `parseSop` decodes them the same way it
decodes the title.

## 7. Where the corpus and the published description disagree

The wiki's structure is right and its instrument layout is right. Six details
are not, and all six are things a player would hit:

1. **`chanMode` bit 7 is undocumented** (§2). It is the editor's
   disabled-channel flag. Mask it off; do not reject.
2. **`iFeedback` is not what it seems for instTypes 7–10** (§3.2). It is
   ignored on the snare and cymbal tracks and only its low four bits are used
   on the hi-hat and tom tracks, so most drum instruments carry junk in it.
3. **Channel mode 0 does not mean the track is empty** (§2). It is the silent
   upper half of a four-operator pair, and 68 of them carry events.
4. **Panning is not always 0/1/2** (§4.2). Five events say 7 or 9, and Note
   plays them as silence.
5. **An instrument index can exceed `nInsts`** (§4.2), 324 times in 7 files.
6. **Value ranges were undocumented** and are now measured (§4.2, §5): volume
   and global volume 0–127, pitch 0–200, note 12–113, length 1–1088, tempo
   2–255.

Everything else the wiki says held: the 76-byte header, the positional layout,
the instrument sizes per type, the two- and four-operator byte orders, the
event codes and their value sizes, the disjoint control-track code space, and
the ±100 reading of pitch.

Park Jin-hong's memo, the likely source of the wiki, gets the event and
instrument layouts right but several header offsets wrong (it puts
`beatMeasure` at 0x40 rather than 0x3A, and gives the header a size that varies
with the track count, where the program always writes 96 bytes). Its pitch
description — the bend interpolates between this note's frequency and the
next one's, by percent — is the right model; Note implements it with the AdLib
driver's 25-step table (§4.2).

## 8. Playing a SOP

A `.sop` is an OPL3 file and this library now has an OPL3 core, so
`IyagiMusic` puts one under it by default — `chip: "auto"` reads the format and
picks `opl3` for a SOP and `opl2` for an `.ims` or `.rol`. Nothing is guessed;
the format says which chip it is for and the player honours it.

**Note is the reference.** It wrote every file, and its authors listened
through it, so `sopSequence` and the driver's SOP mode play a SOP the way
NOTE.EXE's own player does — every behaviour marked *(NOTE.EXE)* in §2–§5 —
except in the few places §8.1 lists.

**On an OPL3 the format fits, and fits exactly.** In rhythm mode a YMF262 has
fifteen melodic voices and the five drums — precisely the twenty tracks §4.1
says a SOP has. `sopSequence` maps rhythm tracks 6–10 onto the five rhythm
voices (which sit at 15–19 on a YMF262, 6–10 on a YM3812), gives each mode-1
track a four-operator channel pair of its own, and allocates the rest per
note. Because a mode-1 track's partner is a mode-0 track, which is not played
(§2), the voices left over are always exactly as many as the tracks left over,
so **nothing is ever cut**: it is Note's own track-to-channel layout, reached
by another route. Four-operator instruments get both operator pairs (§3.3),
wave selects 4–7 are the chip's own, and §4.2's panning becomes the 0xC0 stereo
switches — a SOP is the only thing this library plays that is not mono.

**Only the channel-mode table asks for four operators.** 249 tracks are mode 1
*(measured, 347)*, and those are the tracks that get a joined pair. Thirty more
tracks, in seven files, select a type-0 instrument without being mode 1
*(measured, 347)*; Note plays those as their first operator pair (§3.3), and so does
this library. Earlier revisions promoted them to four operators. On a mode-1
track the reverse also follows Note: a two-operator instrument loads into the
first pair and the second pair keeps whatever it last held, still joined — 1163
notes do this, 1140 of them in `4OPDANCE.SOP` *(measured, 347)*.

A reader writing their own player should note the constraint that forces that
bookkeeping: joining a channel pair silences the upper channel of the pair
(ENGINE_SPEC §10.1), so a four-operator instrument must never be loaded onto a
pair the player has not set aside — it would take a voice another track is
playing on with it.

**Pitch and volume are Note's.** The driver's SOP mode takes the file's pitch
as it stands and plays it on Note's own F-number table, 25 rows to a semitone
with `pitch >> 2` choosing the row (§4.2). That table is not carried: it is the
Ad Lib driver's integer recipe run at 25 steps, and the recipe reproduces all
300 entries of the table inside NOTE.EXE exactly (`SOP_FNUM_TABLE`). Volume
defaults to 96, global volume scales it in integers (§5), and the driver's
volume curve — `63 − (((63 − TL) × volume + 64) >> 7)` on the operators that
reach the output — is the one Note uses *(NOTE.EXE)*. Tempo is what Note's
timer makes of it (`sopTempo`, §5): 120 bpm plays at 120.04, and tempos 2–4
at 4.55.

**On an OPL2 it does not fit, and `chip: "opl2"` asks for that on purpose.**
That path is still there, and is what a SOP got before the OPL3 core existed —
and Note has a mode of its own for it, driving an AdLib card as eleven mono
channels:

- **Voices.** SOP wants 20; an OPL2 has 9, or 6 plus the five rhythm voices.
  Only 38 of 336 files use nine or fewer melodic tracks, and 16 use six or
  fewer; **114 use all twenty** *(measured)*. Melodic tracks share what is
  left, a voice allocated per note, and when all are busy the note that ends
  soonest is cut short — it is the note with least left to lose.
- **Four-operator instruments.** Only the first operator pair is loaded (§3.3).
  61 files are affected *(measured)*.
- **Wave selects 4–7.** The driver masks them to the OPL2's four, so an OPL3
  waveform becomes whichever of the first four shares its low two bits.
- **Panning.** Dropped; the chip is mono. A corrupt pan value still damages
  feedback, as it does in Note (§4.2).

Either way, a track that plays notes without ever sending an instrument-select
gets slot 0, which is Note's default (§4.2). `ST-BGM.SOP` needs it — 4878 notes
and not a single event 6 *(measured)*. In all 101 tracks of the corpus that
rely on the default, slot 0 holds an instrument *(measured, 347)*; where it did
not, Note would play on reset registers, and this library stands in the first
instrument in the table that yields a patch instead.

**Lyrics.** Note has no lyric file, but 79 corpus SOPs have an `.iss` of the
same name *(measured, 347)*. They belong to **HTS** (한글 솦 연주기, 1996–97), by
박진홍 (Park Jin-hong), which plays a SOP with its `.iss` and writes the
`.iss` in an editor copied from IMPLAY's. HTS runs Note's 240 interrupts to
the beat and counts every interrupt for the lyrics. A cue is due when that
count reaches `8 × stored` *(HTS.EXE)*. So cues count 240 ticks to the beat,
as they do beside an `.ims`, not the SOP's `tickBeat`. A cue belongs at SOP
tick `imsTick × tickBeat / 240` and often lands between two SOP ticks.
FILE_FORMATS §4.4 has the code, the corpus measurement that agrees with it,
and the five pairs that do not fit.

### 8.1 Where this library does not follow Note

| Behaviour | Note *(NOTE.EXE)* | This library |
|-----------|-------------------|--------------|
| Bit 7 of the channel mode (§2) | not played | **played** — it is screen state, and two files were saved soloed |
| Default instrument when slot 0 is empty (§4.2) | reset registers | the first instrument that yields a patch |
| Frequency, when a bend equals a quarter of the last one computed | the last result, reused | computed |
| Pitch event on the bass drum track while it sounds, rhythm mode | channel 6 key-on set and left set | ignored |

The last two are bugs in Note's driver, recorded rather than reproduced. Its
bend routine caches the last bend it computed, but compares the new raw value
against the cached value shifted right by two, so a bend of exactly one
quarter of the previous one reuses the previous result — on any channel, since
the cache is shared. And in rhythm mode a pitch event on the bass-drum track
while a bass-drum note sounds rewrites channel 6's frequency with the key-on
bit set, which the drum never clears; 265 such events occur, in 9 files
*(measured, 347)*.

Two smaller things are not modelled either: Note never presets the tom and
snare frequencies, so a snare hit before the first tom note plays at whatever
channel 7 held, where this library starts them at the Ad Lib driver's defaults;
and Note writes a four-operator voice's frequency to its head channel only,
where the driver writes both halves alike.

## 9. Where the files came from: Note's IMS import

Note loads `.sop` and imports `.ims`; it saves only `.sop`. The import explains
more of the corpus than any other single thing *(NOTE.EXE)*:

- **Tracks.** IMS channel *n* becomes track *n*, so an IMS's rhythm channels
  6–10 land on the SOP's rhythm tracks 6–10; tempo events go to the control
  track. Every track starts at mode 2. The IMS title is copied into `title`,
  which is how Johab titles got into files written by a program that cannot
  type Hangul.
- **Events.** A note-on becomes a note whose length runs to its note-off, with
  a volume event first whenever the note's volume byte differs from the
  channel's last volume; `8n` both ends the channel's previous note and starts
  a new one; `An` becomes a volume event; `Cn` an instrument event, whose index
  is the IMS patch number and whose slot is filled from the bank; `En`'s 14-bit
  bend becomes `value × 200 ÷ 16383`. A tempo multiplier becomes a tempo of
  `basicTempo × ii + ff × basicTempo ÷ 128`, capped at 255.
- **Bank.** `<song>.bnk` beside the IMS, else the bank set in the editor, else
  `STANDARD.BNK`; names are matched after converting them to the case the bank
  uses.
- **Resolution.** The IMS clock is taken as 240 ticks per beat, and the song is
  then converted to `tickBeat = 240 ÷ d`, where *d* is the smallest non-zero
  delay in the file, **but no more than 60** — a quarter of a beat.

That last rule is where the corpus's five `tickBeat` values come from. An IMS's
delays are multiples of its source grid (FILE_FORMATS §1.8), so the smallest
one is almost always that grid, and `240 ÷ 30 = 8`, `240 ÷ 20 = 12`,
`240 ÷ 60 = 4`, `240 ÷ 40 = 6`, `240 ÷ 15 = 16` — the SOP values, in the order
of their frequency. It can be checked on the eleven SOPs in the corpus that
share a name and a note sequence with an IMS: in all eleven the SOP's
`tickBeat` is exactly the one the import rule gives, and the note onsets agree
from the start *(measured, 347)*. So the import quantises to the file's own
grid, not to the beat: of the 1724 readable `.ims` files now in the corpus, it
would place every event, note-offs included, exactly on its tick in 1702
*(measured, 1725 `.ims`)*. Of the 22 it would not, 12 are on a grid of 80
ticks — thirds of a beat — which the 60-tick cap cannot express.

**Changing `tickBeat` in the editor is destructive.** Note rescales each
stored delta separately, `delta × new ÷ old` rounded down, so rounding error
accumulates along a track rather than staying on the grid; a note that would
shrink to nothing keeps one tick, and an event that would land on the same tick
as an earlier event of the same kind is pushed one tick later *(NOTE.EXE)*. The
IMS import uses the same routine. None of the eleven matched ports shows any
sign of it, which suggests the scene left `tickBeat` where the import put it.
