# @nicknisi/pi-mg

A **100% File Completion Animation** for the terminal — inspired by the Kier Eagan animation from _Severance_, but starring a pixelated **Michael Grinich** (CEO of WorkOS) instead. Run `/mg`, sit back, and receive your praise.

## What it adds

- **Slash command:** `/mg [name]` — plays the full animation. Defaults to `$USER`, falling back to `WorkOS employee`.
- No tools, no widgets, no custom entry types, no event hooks.

The animation takes over the screen via `ctx.ui.custom()`. Press **Escape** or **q** to bail out at any time; audio is killed on exit.

## Usage

```text
/mg          # plays the animation with your $USER name
/mg Nick     # plays the animation with a custom name
```

### The sequence

1. **MDR grid** — green-on-black grid of shuffling numbers with a progress bar counting to 100%, with accelerating beeps
2. **100% burst** — giant "100%" text explodes into colorful pixel particles over a noise burst
3. **Landscape reveal** — a sunset mountain landscape paints in (violet→pink→orange sky, snow-capped peaks, clouds, a cliff) with a chiptune fanfare
4. **Walk in** — a pixel guy walks in from the left along the cliff
5. **The address** — Michael Grinich's pixelated face appears and delivers the monologue (macOS `say`, Daniel voice), mouth animating, with synced subtitles:

   > _I knew you could do it, {name}. Even in your darkest moments, I could see you arriving here. In refining your code, you have brought glory to this company and to me. I, Michael Grinich, love you. But now I must away, for there are other developers who need me around the world. Goodbye, {name}. And thank you._

6. **The departure** — the pixel guy spreads his arms and flies off across the landscape in an S-curve, shrinking into the distance with a whoosh
7. **Finale** — "100% COMPLETE" with `File: {name} │ Status: REFINED │ WorkOS`

Total runtime is roughly 30 seconds, driven by a 20fps (50ms) tick. The address phase ends when `say` exits, with a hard fallback timeout so a missing/silent `say` can't stall the sequence.

## Files

| File        | What's in it                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| `index.ts`  | Animation component built on pi's `ctx.ui.custom()` TUI API — half-block rendering, ANSI truecolor     |
| `sprite.ts` | Michael Grinich pixel art (32×32, 18-color palette extracted from a photo) + walking/flying sprites    |
| `sound.ts`  | In-memory WAV generation for tones/noise/fanfare/whoosh, played through `afplay`; `say` for the speech |

## Configuration

None. No config file, no options, no environment variables (other than `$USER` for the default name).

## Dependencies

- **Peer:** `@earendil-works/pi-coding-agent` (`*`) for `pi.registerCommand` and `ctx.ui.custom`; `@earendil-works/pi-tui` (`*`) for `matchesKey`.
- No runtime npm dependencies, no workspace deps.

## Caveats

- **macOS only for audio.** `sound.ts` shells out to `afplay` and `say`. On other platforms the animation still renders, but silently, and the address phase falls back to its fixed timeout instead of tracking speech.
- Audio is written to temp WAV files (`os.tmpdir()`) and played as child processes; all spawned processes are killed on dispose/exit.
- TUI-only: in non-`tui` modes the command notifies and returns.
- Requires a truecolor terminal — the renderer emits 24-bit ANSI color with half-block characters. In 256-color terminals the palette will be approximated at best.
- It's ~30 seconds of full-screen animation and noise. Do not run it on a shared screen share unless that is exactly what you want.

## Install

```bash
pi install /Users/nicknisi/Developer/pi-extensions/packages/mg
```
