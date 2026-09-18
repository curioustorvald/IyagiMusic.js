# The OPL3 additions: what is exact, what is not

`OPL2_NOTES.en.md` accounts for the operator, the envelope, the tables and the
rhythm voices, and **all of that is shared**: one core in `src/opl/chip.js`
runs both chips, and a YMF262 is a YM3812 with more of it. This file accounts
only for the additions — the second bank, four more waveforms, four-operator
channels and the stereo switches — on the same terms. No code, table or
constant was carried over from another emulator; the ones available are GPL or
LGPL and this repository is not.

The short version: **the second bank and the stereo switches are exact, the
four waveforms are exact, the four-operator connection table is from the
published description and is testable, and one detail of how a joined pair
reads its pitch is an assumption the corpus cannot disprove.**

## The one that is not a fact

**A joined pair's slave half does not supply pitch or key-on.** Register 0x104
turns channels *c* and *c+3* into one four-operator voice; this implementation
has all four operators take their F-number, block, key-on and key scaling from
the head, and ignores the slave's own 0xA0/0xB0.

That is what the published description of the chip says, and it is what any
driver would want. It is listed here rather than above because **nothing in
this repository can check it**: `driver.js` writes the same F-number and the
same key-on to *both* halves of a pair (ENGINE_SPEC §10), so the two readings
produce identical output on every file in the corpus. The driver does that on
purpose — it is the behaviour that is right under either reading — which means
the assumption is load-bearing for nobody and testable by nobody. If a
gate-level comparison ever shows the slave's F-number does something, only
`#retune` in `chip.js` has to change.

`test/opl3.test.js` pins the current reading ("a joined pair is one voice") so
that it cannot drift silently. It is a record of a decision, not evidence.

## Verified against first principles

Each is asserted by `test/opl3.test.js`, against a rule rather than against a
reference recording.

| Behaviour | Check | Result |
|---|---|---|
| OPL2 compatibility | the same song on an OPL2 and on an OPL3 before 0x105 | identical, sample for sample |
| Register decoding | all 36 operators individually addressable, in both banks | exact |
| Bank gating | the second bank silent, and 0xE0 two bits wide, until NEW | exact |
| Waveforms 4–7 | against their definitions, over all 1024 phases | exact |
| Sawtooth slope | 12.02 dB per eighth of a half cycle | within 2 dB |
| Four-operator connections | each of the four, one audible operator at a time | exact |
| Joinable pairs | six, each a channel and the one three above it | exact |
| Stereo switches | four routings, against what each bus receives | exact |
| Voice numbering | the rhythm voices are the chip's last five rows | exact |

The first row is the load-bearing one. Because one core serves both chips,
every OPL3 feature is a branch that must not fire when it should not, and the
cheapest way to catch one that does is to render a YM3812 song on both and
diff. It also means the OPL2's own accounting — pitch, level, envelope timing,
the five rhythm voices — carries over unchanged rather than being re-argued.

## Derived, with the derivation in the source

- **The four waveforms** are the same quarter sine read differently, so
  `tables.js` builds them out of `LOG_SIN` rather than stating them. 4 is the
  sine at double rate with the second half silent, 5 is that rectified, 6 is a
  square — no attenuation anywhere, just the sine's sign.
- **The sawtooth's slope is fixed by the domain, not chosen.** Waveform 7 is a
  straight line in the *attenuation* domain: a 9-bit ramp scaled by 8 spans
  0…0xFF8 log units, which at 6.0206/256 dB a unit is 96.14 dB — exactly the
  range the envelope and the exponential table span. One half cycle is
  therefore the chip's whole dynamic range, top to bottom, and its two halves
  meet at silence rather than at a step.
- **The four-operator connections** come from reading each half's CNT bit as
  *"this half's first operator goes straight to the output instead of
  modulating"*. That one sentence produces all four rows of the published
  connection figure, which is why it is in the source in place of a table.
- **Feedback belongs to operator 1 alone.** The slave half's feedback setting
  has nothing to act on: operator 3 is fed by the chain rather than by itself.
  This follows from the connection table rather than being asserted beside it.
- **Volume scaling generalises through the same table.** ENGINE_SPEC §4's rule
  is "scale what reaches the output"; §10.2 works out which operators those
  are for each connection.

## Knowingly approximate

- **Everything `OPL2_NOTES.en.md` lists as approximate still is** — the
  tremolo and vibrato waveforms, and the rhythm phase equations. They are the
  same code. The rhythm output level is no longer on that list: the channels
  are summed twice now, which is what the chip is reported to do, though that
  report is second-hand and `OPL2_NOTES.en.md` keeps it labelled as such.
- **Four-channel output is not implemented.** Bits 6 and 7 of 0xC0 are the
  YMF262's other two outputs (CHC and CHD). `.sop` has three panning values
  and no use for them, so they are stored and ignored.
- **The output level of eighteen channels.** One OPL3 voice is exactly as loud
  as one OPL2 voice — the same per-channel DAC level, the same `MIX_SCALE` —
  so twenty voices reach further than nine, and a real YMF262 clips there too.
  The player backs off instead: a default gain of **0.32** against the OPL2's
  0.55, which is **measured, not derived**. The derivation from uncorrelated
  voices says √(9/20) = 0.67 of the OPL2 figure; the corpus says 0.58. Over all
  336 `.sop` files, two seconds each, with no file allowed to lose more than
  0.1% of its samples to the clamp: 0.42 leaves one file at 1.938%, 0.36 leaves
  one at 0.187%, and 0.32 leaves none above 0.022%. Real songs put their
  loudest voices on the same beat, and the corpus knows that better than the
  arithmetic does. Both figures were 0.42 and 0.7 before the rhythm channels
  were summed twice, which is 6 dB more bus in most songs.

## Deliberately absent

The formats never touch these, so they are not implemented: the timers and
their status flags, CSM mode, the four-channel output bits above, and the
OPL3's own 0x105 bit 1 (OPL3-L / "DAM-DVB" on some parts).

## If you want it exact

The same three measurements `OPL2_NOTES.en.md` asks for, plus one: whether a
joined pair's slave half really is mute on pitch and key-on. All four want the
same instrument — a recording from real hardware, or from a gate-level
emulator, compared per-sample. The structure here is arranged for it: the
pair's four operators are read in one function (`#fourOp`), the pitch in
another (`#retune`), and the routing in a third (`#emit`).
