# @nicknisi/pi-header

Replaces pi's built-in TUI header with an animated nicknisi avatar sitting top-left (Claude Code / vim dashboard style), with session info beside it: pi version + model, cwd + git branch, and a random quote typed out character by character. Shown only on fresh sessions; the built-in header is restored the moment the first prompt is sent — like the vim dashboard disappearing when you get to work.

## Install

```sh
pi install npm:@nicknisi/pi-header
```

## What it adds

### Commands

| Command                                        | Description                                                                                                                                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/nicknisi-header`                             | Cycle the header style: `blink` → `waiting` → `full` → `compact`. Re-renders live if the dashboard is currently up.                                                                                      |
| `/nicknisi-header-size [small\|medium\|large]` | Set the GIF size. No argument cycles through the sizes; an unknown size is reported as an error. Persisted to the config file. Only affects `blink`/`waiting` modes; the ASCII art modes are fixed-size. |

### Modes

- `blink` (default) — `nicknisi-blink.gif` as truecolor half-block frames: a close-up blink loop. Picks quotes from `BLINK_QUOTES`.
- `waiting` — `nick-waiting.gif`: a Sonic-style waiting animation (waits 5s, taps its foot, loops). Picks quotes from `WAITING_QUOTES`.
- `full` — the nicknisi ASCII art from the Neovim dashboard (`config/nvim/lua/nisi/assets.lua`, `ascii.nicknisi`), one character per pixel, theme-colored, with randomly-timed blinking eyes.
- `compact` — half-block (`▀`/`▄`) render of the same ASCII art; half the height, muddier.

### Events hooked

| Event                | Behavior                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `session_start`      | If `ctx.mode === "tui"` and the session has no messages (i.e. not a resume), installs the dashboard via `ctx.ui.setHeader(...)`. |
| `before_agent_start` | First prompt sent → calls `ctx.ui.setHeader(undefined)` to restore the built-in header (unless another extension replaced it).   |
| `session_shutdown`   | Stops the animation timer.                                                                                                       |

### UI

A custom header component (`Component` from `@earendil-works/pi-tui`) driven by its own 50 ms `setInterval` (cleared in the component's `dispose()`, which pi calls whenever the header is replaced) that advances GIF frames (per-frame delays from the source GIF), runs the eye-blink state machine for ASCII modes, and types out the quote. Calls `headerComp.invalidate()` + `tui.requestRender()` only when dirty.

The info column (vertically centered against the art) shows:

```
pi  v<VERSION> · <provider>/<model>
~/path/to/cwd  ·  <git-branch>
<quote typed char-by-char>▌
```

Every row is truncated to the terminal width. If the terminal is too narrow for the art plus a 20-column info column, the art is dropped and only the info lines are shown.

Branch is read asynchronously via `git branch --show-current` (`pi.exec`, 2s timeout) and filled in once known; missing branch/repo degrades to just the directory.

## Configuration

### `~/.pi/agent/nicknisi-header.json`

Read at extension load, written by `/nicknisi-header-size`.

```json
{
  "size": "medium"
}
```

| Key    | Type                             | Default    | Description                                                                            |
| ------ | -------------------------------- | ---------- | -------------------------------------------------------------------------------------- |
| `size` | `"small" \| "medium" \| "large"` | `"medium"` | GIF render size for `blink`/`waiting` modes. Roughly 10 / 13–14 / 15–18 terminal rows. |

Write failures are swallowed (non-fatal: size just won't persist). Read failures fall back to `{}`; an unknown `size` value is ignored (default `medium`).

There is no config for the mode itself — mode starts at `blink` every session and is only changed via `/nicknisi-header`.

### Environment variables

None.

## Dependencies

- `@earendil-works/pi-coding-agent` (peer) — `ExtensionAPI`, `ExtensionContext`, `Theme`, `VERSION`, `getAgentDir()`.
- `@earendil-works/pi-tui` (peer) — `Component` type, `truncateToWidth()` and `visibleWidth()` for fitting rows to the terminal.
- `@nicknisi/pi-shared` (workspace) — `formatDirectory()`: collapses `$HOME` to `~` and strips terminal escape sequences from the path before rendering.
- No runtime npm deps. Node builtins used: `node:fs`, `node:path`. git runs via `pi.exec`.

## Frame generation (`gen-frames.mjs`)

The `frames-*.ts` files are generated data — do not edit by hand. Regenerate from source GIFs with:

```sh
node gen-frames.mjs <input.gif> <output.ts> [cols] [pxHeight]
```

Requires ImageMagick (`magick`) on PATH. The script coalesces the GIF (compositing delta-optimized frames), resizes to `cols x pxHeight` pixels, and emits palette-indexed half-block frames:

- `COLORS: [r,g,b][]` — index 0 reserved for transparent
- `CELLS: [fgIdx, bgIdx][]` — index 0 reserved for a space; each terminal cell is two vertical pixels (`▀` with fg=top/bg=bottom, or `▄` for bottom-only)
- `FRAMES: { delay, lines }[]` — lines are arrays of `"cellIdx"` or RLE `"cellIdx*run"` tokens; per-frame delay in ms

Choose a square-ish pixel grid ≈ correct terminal aspect ratio (tuned for Monaspace Neon with `adjust-cell-height=10%` in ghostty). `index.ts` decodes and caches frames lazily with memoized escape sequences.

## Caveats

- Depends on `ctx.ui.setHeader()` accepting a component factory and on `before_agent_start` firing before the first turn — both are pi internals that could change across versions. If `setHeader` semantics change, the restore-on-first-prompt behavior breaks first.
- Truecolor rendering assumes a terminal with 24-bit color support; the theme-based ASCII modes (`full`/`compact`) fall back gracefully to theme colors, but GIF modes will look wrong on 256-color terminals.
- Aspect ratio of GIF modes is baked in at generation time for Monaspace Neon + ghostty `adjust-cell-height=10%`; other fonts/cell heights will distort the image.
- Animation uses a single 50 ms interval while the dashboard is visible; it's stopped when pi disposes the header (first prompt, replacement by another extension) and on shutdown.
- `bgAnsi()` converts theme fg escapes to bg escapes via a string replace of `"38;"` → `"48;"` — depends on pi's theme producing standard SGR escapes.
- All quotes and the ASCII art are hardcoded; changing them requires editing `index.ts`.
