# @nicknisi/pi-spinner

Replaces pi's default working/loading message with a randomly selected phrase on every turn. The list contains ~1000 entries drawn from The Office, Lord of the Rings, Arnold Schwarzenegger / Predator, LinkedIn-influencer satire, gym culture, security-ops jargon, and assorted programming memes. It exists purely to make the wait between turns more entertaining; it changes no agent behavior.

## Install

```bash
pi install /Users/nicknisi/Developer/pi-extensions/packages/spinner-verbs
```

## What it adds

No slash commands, tools, keybindings, widgets, or custom entry types. It only hooks two events:

- `turn_start` — picks a random verb and, while the turn runs, repaints it via `ctx.ui.setWorkingMessage()` on an interval with a Claude Code-style shimmer: a highlight band sweeping left → right across the text. Only the text shimmers — the spinner glyph next to it is untouched.
- `turn_end` — stops the shimmer timer and calls `ctx.ui.setWorkingMessage()` with no argument, resetting the working message to pi's default.

## Usage

Nothing to invoke. Once installed, every agent turn shows a random message in the spinner, e.g.:

```
Getting to the Chopper...
```

A new phrase is sampled independently each turn, so repeats are possible.

## Configuration

Optional, via `~/.pi/agent/configs/spinner.json` (loaded once at extension load). All keys are optional:

```json
{
  "shimmer": true,
  "shimmerIntervalMs": 80,
  "shimmerPeriodMs": 2000,
  "baseColor": "muted",
  "highlightColor": "text",
  "bandWidth": 6,
  "hideSpinner": false
}
```

| Key                 | Default   | Meaning                                                                                                        |
| ------------------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| `shimmer`           | `true`    | Animate the verb text with a sweeping highlight. Set `false` for the old static message.                       |
| `shimmerIntervalMs` | `80`      | Milliseconds between shimmer frames.                                                                           |
| `shimmerPeriodMs`   | `2000`    | Milliseconds for one full left-to-right sweep.                                                                 |
| `baseColor`         | `"muted"` | Theme colour token or `#rrggbb` hex for the resting text. `muted` matches pi's default working-message colour. |
| `highlightColor`    | `"text"`  | Theme colour token or `#rrggbb` hex the highlight sweeps toward.                                               |
| `bandWidth`         | `6`       | Width of the highlight band, in characters.                                                                    |
| `hideSpinner`       | `false`   | Hide the spinner glyph entirely (via `ctx.ui.setWorkingIndicator({ frames: [] })`), leaving only the text.     |

On themes that don't emit truecolor sequences, the smooth gradient degrades to a two-tone band using the configured theme tokens.

The verb list is a hardcoded `VERBS` array in `index.ts`; edit the source to add or remove phrases.

## Dependencies

- `@earendil-works/pi-coding-agent` (peer, `*`) — uses `ExtensionAPI`, specifically `pi.on` for the `turn_start` / `turn_end` events and `ctx.ui.setWorkingMessage()`.

No npm dependencies, no workspace dependencies, no build step. The package ships raw TypeScript (`"pi.extensions": ["./index.ts"]`). The shimmer also uses `getAgentDir` and `ctx.ui.theme` from the same peer.

## Caveats

- Depends on the `turn_start` / `turn_end` event names and the `ctx.ui.setWorkingMessage()` / `ctx.ui.theme` APIs, which are pi extension-API surface; a pi release that renames or removes either will break this extension.
- The shimmer repaints the working message every `shimmerIntervalMs` (default 80ms), the same cadence as pi's built-in spinner animation.
- The selection uses `Math.random()` with no deduplication, so the same phrase can appear on consecutive turns.
- Because it hooks `turn_start` without checking event payload, it overrides the working message even in contexts where another extension may have set one; the last `setWorkingMessage` call wins.
