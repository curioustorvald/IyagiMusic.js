# The OPL2 core: what is exact, what is not

`src/opl/` is an original implementation, written from public hardware
documentation. No code, table or constant was carried over from another
emulator — the ones available are all GPL or LGPL and this repository is not,
and in any case a reimplementation is only worth having if you can say where
each number came from. This file is that accounting.

It is also the core of the OPL3, which is the same silicon with more of it:
everything below applies to both chips, and what the YMF262 *adds* — the
second register bank, four-operator channels, stereo and waveforms 4–7 — is
accounted for separately in `OPL3_NOTES.en.md`.

The primary source is Yamaha's own *YM3812 Application Manual*, cited below by
section and table number. Where it is silent — it never describes how the
rhythm voices are generated, only how to voice them — the source is the
published description of the die, and the entry says so.

The short version: **pitch, level, envelope timing, the modulation index and
the five rhythm voices are right; the tremolo and vibrato waveforms are an
approximation, and one number in the rhythm mix rests on a second-hand
report.**

## Verified against first principles

Each of these is asserted by `test/opl.test.js`, against a formula rather than
against a reference recording.

| Behaviour | Check | Result |
|---|---|---|
| Output frequency | against `fnum × 49716 / 2^(20−block)` | within 0.1% across the F-number and block range |
| Total level | against 0.75 dB a step | within 0.15 dB |
| Decay and release time | against Table 3-6 of the application manual, all 64 rates | within 0.6% |
| Attack time | against the same table | 6% short throughout |
| Maximum rate | RM 15 gives one time for all four RL, as the table does | exact |
| Rate 0 | holds its level indefinitely | exact |
| Log-sin / exp tables | computed from their closed forms | bit-exact by construction |
| Register decoding | all eighteen operators individually addressable | exact |
| Modulation index | a full-scale modulator sweeps the carrier ±4 cycles, and feedback 7 is half that | exact by construction |
| Rhythm mix | one rhythm voice against one melodic voice at the same level | exactly 2× |

The last row is there because it was a real bug: operator registers address an
operator by the low **five** bits of the register, running to 0x15, while
channel registers use the low four. Masking both the same way silently aliases
the third bank of operators onto the first, which does not crash — it just
makes some songs play with the wrong instruments and others fall silent.

## Derived, with the derivation in the source

- **Sample rate** 3579545 ÷ 72 = 49716.05 Hz.
- **Log-sin** `round(−log2(sin((i + ½)·π/512)) · 256)`, and **exp**
  `round((2^(i/256) − 1) · 1024)`. Computed in `tables.js`, not pasted.
- **Attenuation domain.** The envelope counts in 0.1875 dB over 9 bits, total
  level in 0.75 dB over 6. The exponential table's unit is 1/256 of a power of
  two — 0.0235 dB — so the envelope scales by 8 and total level by 32.
- **Key scale level.** Eight units to the octave at 0.75 dB each gives the
  documented 6 dB/octave at setting 3. The sixteen-entry ROM is
  `round(8·log2(i)) + 24` except at i = 7, 9, 14 and 15, where it is one unit
  higher; the ROM values are used. Settings 1 and 2 are the wrong way round —
  1 is 3.0 dB/octave and 2 is 1.5 — which is the chip's quirk, not a slip.
- **Feedback, and the modulation index it does *not* fix.** Feedback is
  documented as π/16 … 4π of phase modulation for settings 1…7. Full-scale
  output is ±4096 and a cycle of phase is 1024 units, so 4π is a halving:
  `(out + prev) / 2 >> (8 − feedback)`.

  That is the **only** modulation figure the manual gives, and it is about the
  feedback path. The direct path — an operator reading another operator — takes
  the modulator's output **whole**, which by the same arithmetic is ±4 cycles,
  or 8π: twice the strongest feedback. Nothing first-party says so; what says
  so is that the alternative was measured and is wrong (below).
- **Envelope rate.** Table 3-6 of the application manual, "Attack and Decay
  Times for Various Rates", states a time in milliseconds for every one of the
  64 key-scaled rates, over the full 0 dB … 96 dB range. Two readings of it fix
  the entire envelope clock. The rate's top four bits (RM) double the speed at
  every step, and its bottom two (RL) scale it by (4 + RL)/4 — the table's four
  RL entries at any RM are that ratio to the last digit, which is a counter
  taking four, five, six or seven of every eight opportunities. And one
  envelope step being 0.1875 dB makes a full decay 512 of them, which turns the
  table's 9.60 ms at RM 13, RL 0 into **one step a sample**. RM 15 saturates:
  all four of its entries read the same 2.40 ms, so the maximum rate ignores RL.
  Attack is exponential — each step closes a fixed fraction of the remaining
  distance, 36 steps from silence to full — which is both why attack rate 15 is
  instant and why the table's ratio of decay time to attack time is a constant
  13.9 at every rate.
- **The manual's clock is not an AdLib card's.** Table 3-6's milliseconds work
  out to a 3.84 MHz master clock, not the 3.579545 MHz crystal an AdLib card
  carries: 512 steps at one a sample is 10.30 ms here against the table's 9.60.
  Everything is therefore 7.3% slower than the printed figure, and the test
  scales by 3.84/3.579545 before comparing. The counter is the hardware fact;
  the millisecond is a consequence of whatever crystal is fitted.

## Fixed after measuring

- **Envelope clock, four times too slow.** Every attack, decay and release ran
  at a quarter speed, because the step period was derived from the doubling law
  alone. The doubling law is scale-free, so the test that asserted it passed
  just as happily at a quarter speed — nothing in the suite had an absolute
  anchor until Table 3-6 was read off the manual. What it cost was the whole
  character of the chip: percussive patches sustained like an organ, plucked
  and struck instruments arrived soft, and songs came out mushy in a way that
  no single patch could be blamed for. Decay and release now sit within 0.6% of
  the manual across all 64 rates.
- **The snare drum was silent.** Its phase was taken from bit 9 of the hi-hat
  operator's accumulator rather than bit 8, which left it switching between
  0x000 and 0x200 — the sine's two zero crossings, 50 dB down. It contributed
  nothing at any pitch or level, in 1036 of the 1128 corpus songs. The hi-hat
  and top cymbal shared a garbled version of the same mistake: the right two
  accumulators, the wrong bits out of them.
- **Operator output scale.** The exponential table plus its implicit leading
  bit spans 1024…2047, and the first version stopped there — so full scale was
  ±2042 where the chip's is ±4084. Since an operator's output *is* the phase
  deviation handed to the next one, that halved both the modulation index and
  the feedback depth, and every FM patch came out dull. The documented
  feedback anchor catches it: setting 7 is 4π, two whole cycles of a 1024-step
  phase, which only works out at a full scale of 4096. Measured on a 1:1 pair
  at full level, harmonics above 1% of the peak went from the 11th to the
  18th. Nothing else moved: pitch, total level and envelope timing are
  unaffected, and the mix scale was halved to keep the output level.

- **The direct modulation path was halved.** `#twoOp` scaled the modulator's
  output by ½ before handing it to the carrier's phase, which put a full-scale
  modulator at 4π — exactly equal to feedback 7. That equality is not a
  documented fact about the chip; it is what you get by scaling the one path
  the manual leaves open to match the one figure it states. The cost was
  brightness, right across the format: on a 1:1 pair at full level, harmonics
  above 1% of the peak reached only the **18th** where they should reach the
  **32nd**. It is the same bug as the ±2042 output scale above, one layer
  further in, and it survived that fix precisely because the feedback anchor
  goes on validating the *other* path. Reported as an FM sound that was mild
  rather than snappy next to an AdPlug-based player; found by elimination after
  the envelope, the attack curve and the rhythm level had each been measured
  and cleared.

- **The rhythm channels are summed twice.** In rhythm mode channels 6, 7 and 8
  reach the accumulator twice over, so the five drums sit 6 dB above where the
  same operators would sit on a melodic channel. Leaving it out cost 3.0 dB of
  mix level and 4.0 dB of peak on a drum-heavy song, and it is what made a
  rhythm-mode song — 1036 of 1128 in the corpus — sound mild.

  **This one is second-hand and stays labelled as such.** Every emulator that
  implements it reports it as verified against a real YM3812, but Yamaha's
  manual documents the drums only as tonal advice (§5-4) and says nothing about
  the mix, so there is no first-party table here of the kind that fixes the
  envelope clock. What decided it was listening, with everything else ruled out
  by measurement first. `RHYTHM_MIX` is one named constant so that a hardware
  recording can settle it either way without hunting.

## Knowingly approximate

- **Tremolo and vibrato** are computed as an analytic triangle at the
  documented depths (1.0/4.8 dB and 7/14 cents) and rates (≈3.7 Hz and
  ≈6.1 Hz), rather than as the chip's stepped tables. The depths and rates are
  right; the waveform is smooth where the chip's is stepped. 28% of corpus
  patches enable tremolo and 23% vibrato, so this is audible in aggregate and
  wrong in no particular note.
- **The rhythm phase equations** are the hardware's own function, taken from
  the published description of the die rather than from anyone's code. The
  application manual documents the drums only as tonal advice (§5-4) and says
  nothing about how they are generated, so unlike the envelope there is no
  first-party table to check them against. What can be checked, and is:
  every voice sounds; the hi-hat and snare are broadband and the tom-tom is a
  plain sine; and retuning channels 8 and 9 does not simply transpose the
  hi-hat and cymbal, because their phase comes from single bits of two
  accumulators rather than from either accumulator's value.
- **Output scaling.** Nine channels into one mono bus can reach well past
  full scale, and the chip's own DAC would clip there too. The player backs
  off — a default gain of **0.55**, measured over all 1366 corpus `.ims` files
  two seconds each so that no file loses more than 0.1% of its samples to the
  clamp — rather than reproducing the card's clipping. That is a deliberate
  difference in kind, not a rounding: a player that clipped would sound louder
  and punchier than this one, because clipping *is* peak limiting. It was 0.7
  until the rhythm channels started being summed twice.

## Deliberately absent

The formats never touch these, so they are not implemented: the two timers and
their status flags, CSM mode, and the composite sine mode of the OPL2's status
register.

The OPL3's additions — the second register bank, four-operator channels,
stereo and waveforms 4–7 — **used to be on that list and are not any more.**
`.sop` is an OPL3 format and needs every one of them; `OPL3_NOTES.en.md`
accounts for them. They cost this file nothing: all four hang off register
0x105, so a YM3812 is what the core is before anything sets it, and
`test/opl3.test.js` renders the same song on both chips and diffs it to keep
that true.

## If you want it exact

The way to close the remaining gap is a recording from real hardware or from a
gate-level emulator, compared per-sample. Three things are worth measuring
first, in this order: whether the rhythm channels really are summed twice, which
is the one number here resting on a second-hand report; whether the attack's 6%
is the curve or the manual's own rounding; and the stepping of the tremolo and
vibrato tables. A fourth, if the drums still do not sit right: the top cymbal is
the only rhythm voice whose phase lands on the sine's peak at both of its two
values, so it is a ±full-scale square where the others are partial — and the
phase equations are the part with no first-party check. The structure here is arranged for it — every
constant is named and exported, the envelope's rate handling is one function
and its step another, and the drums are one more. None of it is spread across a
per-sample loop that would have to be rewritten.
