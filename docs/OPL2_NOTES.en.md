# The OPL2 core: what is exact, what is not

`src/opl/` is an original implementation, written from public hardware
documentation. No code, table or constant was carried over from another
emulator — the ones available are all GPL or LGPL and this repository is not,
and in any case a reimplementation is only worth having if you can say where
each number came from. This file is that accounting.

The short version: **pitch, level and envelope timing are right; the metallic
drums are an approximation.**

## Verified against first principles

Each of these is asserted by `test/opl.test.js`, against a formula rather than
against a reference recording.

| Behaviour | Check | Result |
|---|---|---|
| Output frequency | against `fnum × 49716 / 2^(20−block)` | within 0.1% across the F-number and block range |
| Total level | against 0.75 dB a step | within 0.15 dB |
| Envelope rate | decay time halves for each step of the rate | exact |
| Rate 0 | holds its level indefinitely | exact |
| Log-sin / exp tables | computed from their closed forms | bit-exact by construction |
| Register decoding | all eighteen operators individually addressable | exact |

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
- **Feedback.** Documented as π/16 … 4π of phase modulation for settings 1…7.
  Full-scale output is ±4096 and a cycle of phase is 1024 units, so 4π is a
  halving: `(out + prev) / 2 >> (8 − feedback)`.
- **Envelope rate.** The published attack and decay times both scale as
  `1 << (15 − rate)`, which is what a counter whose period halves with every
  step of the rate's top four bits produces. The bottom two bits interpolate
  between those octaves by taking four, five, six or seven of every eight
  opportunities. Attack is exponential — each step closes a fixed fraction of
  the remaining distance — which is why attack rate 15 sounds instantaneous
  even though the counter can only move one step a sample.

## Fixed after listening

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

## Knowingly approximate

- **Tremolo and vibrato** are computed as an analytic triangle at the
  documented depths (1.0/4.8 dB and 7/14 cents) and rates (≈3.7 Hz and
  ≈6.1 Hz), rather than as the chip's stepped tables. The depths and rates are
  right; the waveform is smooth where the chip's is stepped. 28% of corpus
  patches enable tremolo and 23% vibrato, so this is audible in aggregate and
  wrong in no particular note.
- **Hi-hat and top cymbal.** On real hardware these are a specific function of
  the phase accumulators of channels 7 and 8 combined with the noise
  generator, at gate level. Here they are a square derived from the same two
  phases, XORed with noise for the hi-hat. The snare is the documented
  channel-7 phase bit against noise, and the tom and bass drum are exact. What
  this costs is the precise timbre of two of the five drums.
- **Output scaling.** Nine channels into one mono bus can reach about 1.4×
  full scale, and the chip's own DAC would clip there too. The player backs
  off by a default gain of 0.7 and clamps the rest, rather than reproducing
  the card's clipping.

## Deliberately absent

The formats never touch these, so they are not implemented: the two timers and
their status flags, CSM mode, the composite sine mode of the OPL2's status
register, and anything OPL3 (four-operator channels, the second register bank,
stereo, waveforms 4–7).

## If you want it exact

The way to close the remaining gap is a recording from real hardware or from a
gate-level emulator, compared per-sample. The structure here is arranged for
that: every constant is named and exported, the envelope's rate handling is
one function, and the drums are one more. None of it is spread across a
per-sample loop that would have to be rewritten.
