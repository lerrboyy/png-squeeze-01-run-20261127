# PNG Squeeze — Squeeze screenshots into the smallest PNG

[![Competition](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![Rank](https://make.fun/badge/png-squeeze-01-run-20261127/lerrboyy/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![Reward](https://make.fun/badge/png-squeeze-01-run-20261127/lerrboyy/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

A program that losslessly re-encodes 8 screenshots (1280×720 RGBA) as the
smallest PNGs possible — a make.fun bounty entry for
[png-squeeze-01-run-20261127](https://make.fun/bounty/png-squeeze-01-run-20261127).

## How it works

`main.ts` (Node 22, standard library only, no network, nothing installed)
reads each `/input/<id>/image.png` and writes `/output/<id>/image.png`.
Every pixel decodes back exactly — red, green, blue and alpha, including
the colour of fully transparent pixels.

It beats make.fun's own fixed-Paeth house baseline three ways:

- **Colour-type reduction.** A screenshot with at most 256 colours becomes
  a 1-byte-per-pixel palette image (entries ordered by frequency or by
  luminance, transparent entries first so the tRNS chunk stays short); a
  grey screenshot becomes grey or grey+alpha; an opaque one becomes RGB.
  A single fully-transparent value can even be carried by a tiny tRNS key
  instead of a whole alpha channel.
- **Per-row filter choice.** Each row gets the filter that compresses
  best — fixed filters, the minimum-signed-sum heuristic, fewest distinct
  byte pairs, or a brute-force trial that really compresses all five
  candidates for the row (brute force only on narrow forms, where it was
  measured to pay).
- **Zlib tournament.** Every candidate is screened at level 6, then the
  best two are re-compressed at five fixed zlib settings (level 6, level
  9, level 9 with memory level 9, level 9 with the filtered-data strategy
  at memory levels 9 and 8) and the smallest file wins.

The work plan is fixed — same forms, same filter choices, same zlib
settings, in the same order — so two executions write identical bytes
(verified: two practice runs produce byte-identical outputs). It never
removes the output directory itself; folders are created as needed and
files overwritten in place.

## Practice score (published practice set, kit scorer)

| | Score |
|---|---|
| This entry | **705,542** |
| House baseline (fixed-paeth 1.0.0) | 420,399 |
| Scale (make.fun's scale compressor) | 666,667 |

Per instance: i001 718, i002 706, i003 675, i004 696, i005 742, i006 691,
i007 702, i008 714 (of 1000 each). All 8 instances answered, all exact —
the scorer confirms zero differing pixels. Runtime: ~14 s for the whole
set of 8, inside the 60 s wall budget.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Design

The full prose design spec — what was studied, what was measured, what
was tried and discarded — was written before the code and the program was
built fresh from it (see `png-squeeze-01-run-20261127-design.md` in the
build workspace).
