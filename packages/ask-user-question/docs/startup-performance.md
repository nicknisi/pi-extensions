# Startup import resolution

Pi loads this package's published TypeScript sources directly through Jiti. A
relative `.js` specifier whose target exists only as `.ts` still works, but makes
Jiti perform fallback resolution even when its transform cache is warm. Naming the
real `.ts` file avoids that fallback.

This note comes from upstream (`@juicesharp/rpiv-ask-user-question`), which switched
its eager import graph to `.ts` specifiers. This fork currently keeps `.js`
specifiers, and no repository script enforces either form. The questionnaire UI is
still loaded lazily and pre-warmed, as described in [hosts.md](./hosts.md).

## How the upstream numbers were measured

No benchmark script ships in this repository. Upstream measured startup by:

- Packing the baseline and patched package with `npm pack --ignore-scripts` and
  extracting both into equal-depth paths, with identical copies of the optional
  `rpiv-i18n` sources when testing that configuration.
- Running Pi with `PI_TIMING=1` in an isolated home, agent directory, and working
  directory, with discovery and startup network operations disabled and no model
  calls.
- Starting a fresh process per sample, discarding two warm-ups per variant,
  alternating execution order, and recording 15 samples per variant.

`importMs` is Pi's extension-import timing, including shared loader setup because
this extension loads first. `wallMs` measures the complete empty print-mode
process, **not** time until an interactive editor is ready. Neither measures
first-ever/cold-cache installation or first-question rendering.

## Example upstream measurements

Pi 1.2.0, Node v26.0.0, macOS arm64; 15 measured fresh processes per variant,
following two warm-ups each:

| Optional i18n | Metric           | Baseline median | Patched median |
| ------------- | ---------------- | --------------: | -------------: |
| Absent        | Extension import |           97 ms |          23 ms |
| Absent        | Whole process    |       327.74 ms |      252.84 ms |
| Present       | Extension import |           99 ms |          25 ms |
| Present       | Whole process    |       330.06 ms |      254.88 ms |

The improvement was approximately **74 ms of import time** and **75 ms of
whole-process time** in both configurations. Factory time stayed at 0–1 ms.

Results depend on the host, loader version, filesystem, and caches; they are not a
universal latency guarantee.
