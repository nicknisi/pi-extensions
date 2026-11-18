# @nicknisi/pi-composer

The whole bottom of pi's screen as one configurable system: the input box, the footer, the row above the box, and how pi's working message and spinner look. Pick a style, then override any part of it.

```jsonc
// ~/.pi/agent/configs/composer.json
{ "style": "toad" }
```

Composer 1.0 replaces three packages: the 0.x composer (input box), `@nicknisi/pi-statusline` (footer) and `@nicknisi/pi-spinner` (working verbs). See [Migrating from 0.x](#migrating-from-0x).

## Install

```sh
pi install npm:@nicknisi/pi-composer
```

## Styles

| Style               | Look                                                                                                                                                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `classic` (default) | Rounded box, label on the top border, one footer row: model, thinking, cost, lines changed, 5h/7d usage, statuses, context bar, branch and PR. The 0.x composer + statusline look.                                                                                         |
| `toad`              | After [Toad](https://willmcgugan.github.io/announcing-toad/): a tall padded box with a placeholder, a rainbow sweep on the top border while pi works, `π Morse coding gravity... 1,284 tokens` above the box, breadcrumb chips (`◆ Claude Opus 5.5 ‹ high`) as the footer. |
| `keycaps`           | After the Codex composer: a shaded slab instead of a box, the keys you can press right now on the left (they change with the state), context pinned on the right, toasts for collapsed pastes.                                                                             |
| `starship`          | After Starship and Powerlevel10k: an info line above the input (`pi-extensions on ⎇ main via ◆ Opus high`), a bare `❯` that spins while pi works, context and cost as a right prompt that hides when your text reaches it. No footer.                                      |
| `sidepanel`         | After btop: a titled box, with meters (context, usage, tokens/s graph, cost, lines) in a panel beside it on panes 100+ columns wide. Narrower panes fold the panel into one footer row.                                                                                    |

Try one without editing anything: `/composer style toad`. That lasts for the session, shows the style as shipped (your overrides are paused), and `/composer style` goes back. `/composer preview` steps through every state (typing, paste, working, tool, prompt, near-full, scrolled) so you can judge a style without running an agent.

## Configuration

One file, `~/.pi/agent/configs/composer.json`. Every key is optional. Values resolve as **built-in defaults ← the style ← your overrides**; objects merge key by key, lists (slots, spinner frames) replace. Run `/composer` after editing: it reloads, reports problems, and shows whether usage data is reachable.

```jsonc
{
  "style": "classic",

  // The symbol before your input, and what happens to it while pi works.
  "prompt": {
    "symbol": "❯",
    "color": "accent",
    "whenBusy": "spinner", // "spinner": the symbol becomes the spinner. "symbol": it stays.
    "states": {
      // per-state overrides, see States below
      "nearFull": { "color": "error" },
      "typing": { "symbol": "›" },
    },
  },

  "spinner": {
    "frames": "dots", // a preset name, or your own list: ["◐", "◓", "◑", "◒"]
    "intervalMs": 80, // 0 = the preset's own speed
    "color": "accent",
  },

  "box": {
    "border": "rounded", // rounded | square | heavy | rule | slab | none
    "color": "border",
    "focusColor": "accent", // border colour while this tmux pane has focus; null turns it off
    "background": "userMessageBg", // slab only: background theme token
    "padX": 1, // spaces inside the box, left and right
    "padY": 0, // blank rows inside the box, top and bottom
    "placeholder": null, // dim text in an empty input, e.g. "Ask pi anything"
    "inlay": "plain", // border inlays as " text " (plain) or "┤text├" (bracket)
    "busyEffect": "pulse", // off | pulse | shimmer | rainbow, while pi works
    "effectColor": "accent",
    "effectPeriodMs": 2000,
    "states": { "nearFull": { "color": "context" } },
    "menuGap": 0, // blank rows between the box and the autocomplete menu
    "menuIndent": 1,
  },

  // The working message (folded in from pi-spinner).
  "working": {
    "messages": "verbs", // "verbs": a random fun verb per turn. "default": pi's own. Or your own list.
    "shimmer": true, // a highlight band sweeping across the message
    "shimmerPeriodMs": 2000,
    "bandWidth": 6,
    "baseColor": "muted",
    "highlightColor": "text",
  },

  // What goes where. Each slot is a list of items; a nested list is a group.
  "slots": {
    "above": ["working"],
    "topLeft": [],
    "topRight": ["label"],
    "bottomLeft": [],
    "bottomRight": [],
    "rightPrompt": [],
    "footerLeft": [["model", "thinking"], "cost", "lines", "usage", "statuses", "context"],
    "footerRight": [["branch", "pr"]],
    "panel": [],
    "panelTop": [],
    "panelBottom": [],
  },

  // Per-item options.
  "items": {
    "context": { "show": "bar", "barWidth": 20, "label": "ctx" },
    "statuses": { "hide": ["mcp"] },
    "branch": { "priority": 99, "icon": "⎇", "prefix": "on ", "color": "success" },
  },

  "icons": "nerd", // nerd | unicode | ascii (default glyphs; items.<name>.icon overrides)
  "separator": " │ ", // between items
  "groupSeparator": " ", // between items in a group
  "toasts": false, // short-lived messages over the footer (e.g. "pasted 42 lines")
  "panel": { "width": 34, "minWidth": 100 },
}
```

Problems are reported, never fatal. An unknown key, slot, item or state warns with a suggestion (`unknown item "brnch" (did you mean "branch"?)`), and a bad value falls back to the style's value.

### Slots

| Slot                               | Where                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `above`                            | A row above the box. It's a pi `aboveEditor` widget, so it stays on screen while a dialog replaces the input.                                                      |
| `topLeft`, `topRight`              | Inlays on the box's top border (or a row above the input for `slab` and `none`).                                                                                   |
| `bottomLeft`, `bottomRight`        | Inlays on the bottom border.                                                                                                                                       |
| `rightPrompt`                      | Right-aligned on the first input line, like zsh's `RPROMPT`. Hidden when your text gets within two cells of it.                                                    |
| `footerLeft`, `footerRight`        | The footer row. With both empty there is no footer row.                                                                                                            |
| `panel`, `panelTop`, `panelBottom` | A panel beside the box (one item per row, plus its titles) when the pane is at least `panel.minWidth` wide. Narrower panes show these items in the footer instead. |

A row with nothing to say takes no space: no working message while idle, no cost before any spend, no branch outside git. A row whose only remaining items are `text:` literals is hidden too, so `["working", "text:esc to interrupt"]` only shows while pi works.

### Items

| Item           | Shows                                                                                                                  | Shorter forms                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `label`        | Text pushed over `composer:set-label`, else the session name                                                           | truncated                                                      |
| `model`        | `Claude Opus 5.5`                                                                                                      | `Opus 5.5`, `opus`                                             |
| `thinking`     | Thinking level, on reasoning models                                                                                    |                                                                |
| `cost`         | Session cost, once it's above $0.001                                                                                   |                                                                |
| `lines`        | Lines added/removed by edits (`+38/-12`)                                                                               |                                                                |
| `usage`        | Anthropic 5h and 7d plan windows with reset times (`items.usage.showBelow` hides it until a window drops below that %) | `5h 62% 7d 81%`, `5h 62%`                                      |
| `context`      | Context left: `show` is `bar` (an elastic meter), `percent`, or `tokens`                                               | `71% ctx`, `71%`                                               |
| `branch`       | Git branch                                                                                                             | truncated                                                      |
| `pr`           | Open PR for the branch (`#226`, a link), via `gh`                                                                      |                                                                |
| `cwd`          | Working directory name                                                                                                 |                                                                |
| `statuses`     | Every extension status (`ctx.ui.setStatus`), minus `items.statuses.hide`                                               | first status + count (`? ctrl+. to answer +1`), then truncated |
| `status:<key>` | One extension status, e.g. `status:answer-hint`                                                                        |                                                                |
| `working`      | pi's working indicator: spinner and message, and also pi's retry and compaction notices                                | truncated                                                      |
| `elapsed`      | Time since pi started working                                                                                          |                                                                |
| `tokens`       | Output tokens this run (`1,284 tokens`)                                                                                | `1.3K tok`                                                     |
| `tps`          | Tokens per second, with a sparkline                                                                                    | rate only                                                      |
| `hints`        | Keys you can press in the current state, from your keybindings (none while a dialog shows its own)                     | fewer keys                                                     |
| `mode`         | A state badge: `READY`, `INSERT`, `WORKING`, `ASK`, …                                                                  |                                                                |
| `paste`        | `3 lines · 1 paste` while the input has several lines or a collapsed paste                                             | `3L`                                                           |
| `scroll`       | `↓ scrolled · ctrl+end to follow` while the transcript is scrolled back                                                | shorter                                                        |
| `text:…`       | Literal text, e.g. `text:esc to interrupt`                                                                             |                                                                |

Every item also takes `priority`, `color`, `icon` (`""` hides the default glyph), `prefix` and `suffix` (painted dim, e.g. `"on "`).

### When a row is too narrow

One rule for every row: **the lowest-priority item gives way first.** It switches to its shorter forms one at a time, then truncates (if it can) or disappears, before the next item is touched. Once the row fits, higher-priority items get their fuller forms back if there's room, and elastic items (the context bar) take whatever width is left. Default priorities, highest first: `working` 95, `scroll` 92, `mode` 90, `context` 88, `elapsed` 85, `model` 80, `paste` 78, `thinking` 70, `label` 65, `pr` 55, `branch` 50, `tokens` 48, `statuses` 45, `cwd` 45, `hints` 40, `tps` 35, `cost` 30, `lines` 25, `usage` 20, `text:` 5. Change any of them with `items.<name>.priority`.

### States

`prompt.states` and `box.states` take overrides per state. Several states can apply at once (typing while context is nearly full); they apply in this order, later winning:

`idle` → `typing` → `paste` → `scrolled` → `nearFull` → `working` → `tool` → `prompt`

`nearFull` means Checkpoint published `warning` or `error` for the context meter, or (without Checkpoint) less than 15% context left. `prompt` means pi is waiting on a dialog (`ui_prompt_start`).

### Colours

Any theme token (`accent`, `border`, `muted`, `dim`, `success`, `warning`, `error`, `thinkingMax`, `syntaxKeyword`, …) or a `#rrggbb` hex value. `"context"` means the current context colour (Checkpoint's policy colour when it publishes one), which is how `box.states.nearFull.color: "context"` turns the border amber, then red.

### Spinner presets

`dots`, `disc`, `moon`, `star`, `orbit`, `corners`, `triangle`, `line`, `pulse`, `scanner`, `mini-scanner`. Or give `spinner.frames` your own list. There's only ever one spinner on screen: with `prompt.whenBusy: "spinner"` the prompt symbol spins and the `working` item shows just the message; with `"symbol"` the `working` item carries the spinner.

## Extension API

Over pi's shared event bus (`pi.events`), so nothing needs to import composer.

```ts
// Show text in the `label` item (wins over the session name). Empty or absent text clears it.
pi.events.emit('composer:set-label', { text: `⏱ ${elapsed}` });

// Composer asks on every session start; answer so load order doesn't matter.
pi.events.on('composer:label-request', () => pi.events.emit('composer:set-label', { text: currentLabel() }));
```

Composer also emits `composer:context-bar` (`true` when any slot shows `context`, `false` on shutdown) and answers `composer:request-context-bar` with it. Checkpoint uses this to hide its own context widget, and colours composer's meter through `self-compact:context-color`.

## Other behaviour

- **Paste again to expand**: pi collapses large pastes (more than 10 lines or 1000 characters) into `[paste #N +X lines]`. Paste the same content again while the marker is in the input and it expands inline.
- **History recall puts the cursor at the end**: pi places the cursor at the start of a message recalled with Up. Composer moves it to the end, so you can keep typing.
- **Focus indicator**: `box.focusColor` colours the border while this tmux pane has terminal focus (needs tmux `focus-events on`).
- **Idle means idle**: composer runs no timers unless something is animating (busy spinner, busy effect, shimmer, a pending toast).

## Migrating from 0.x

Composer 1.0 reads a new nested config. A `composer.json` with 0.x keys gets one error naming them, and those keys are ignored.

| 0.x key                                                              | 1.0                                                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `boxedView: false`                                                   | `box.border: "rule"`                                                                             |
| `corners`                                                            | `box.border` (`rounded`, `square`, `heavy`)                                                      |
| `boxPadX`                                                            | `box.padX`                                                                                       |
| `borderColor`, `focusedBorderColor`, `focusIndicator: false`         | `box.color`, `box.focusColor`, `box.focusColor: null`                                            |
| `prefix`, `prefixColor`                                              | `prompt.symbol`, `prompt.color`                                                                  |
| `spinner: false`                                                     | `prompt.whenBusy: "symbol"`                                                                      |
| `spinnerStyle`, `spinnerFrames`, `spinnerIntervalMs`, `spinnerColor` | `spinner.frames` (preset name or list), `spinner.intervalMs`, `spinner.color`                    |
| `glow: false`, `glowStyle`, `glowColor`, `glowPeriodMs`              | `box.busyEffect` (`off`, `pulse`, `shimmer`, `rainbow`), `box.effectColor`, `box.effectPeriodMs` |
| `rainbowPeriodMs`                                                    | `box.effectPeriodMs` with `busyEffect: "rainbow"`                                                |
| `sessionName: false`                                                 | remove `label` from its slot                                                                     |
| `sessionNamePosition`, `sessionNameBorder`                           | move `label` to `topLeft`, `topRight`, `bottomLeft` or `bottomRight`                             |
| `sessionNameColor`                                                   | `items.label.color`                                                                              |
| `sessionNameFormat`, `sessionNameMaxWidth`                           | `box.inlay`; labels truncate to fit                                                              |
| `menuGap`, `extraMenuIndent`                                         | `box.menuGap`, `box.menuIndent`                                                                  |
| statusline.json `hiddenStatuses`                                     | `items.statuses.hide`                                                                            |
| spinner.json `shimmer`, `baseColor`, …                               | `working.*` (see the spinner package README)                                                     |

Remove `@nicknisi/pi-statusline` and `@nicknisi/pi-spinner` from your pi packages; their last releases are stubs that only print a notice. Statusline's tmux status files are written by fleet's pi hook.

## Dependencies

Peer dependencies: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai` (types). External commands, all optional and async: `gh` (PR lookup), `curl` and macOS `security` (Anthropic usage), `tmux` (focus).

## Caveats

- **pi internals**: paste-expand and history-cursor reach into pi-tui `Editor` privates (`state`, `pastes`, `pasteCounter`, `historyIndex`, …) and override the TS-private `handlePaste` and `navigateHistory`. The box is drawn by re-wrapping pi's stock editor render, detecting its `─` rules and `↑/↓ N more` hints by string matching. A pi-tui change to either can break them.
- **One editor**: pi's `setEditorComponent`, `setFooter` and working indicator are last-call-wins. Another extension that replaces any of them after composer takes that piece over.
- **Narrow panes**: if the input would be narrower than 4 cells, composer falls back to pi's stock editor for that frame.
- **pi's `editorPaddingX` setting** doesn't apply inside composer (it would stack with composer's own padding); use `box.padX`.
- **Usage** is shown only for Anthropic models and needs an Anthropic OAuth token (pi's `auth.json`, or Claude Code's keychain entry on macOS). `/composer` reports why it's missing.
- **Colour effects** (`pulse`, shimmer) need theme tokens that resolve to truecolor; otherwise they fall back to a steady colour. `rainbow` always uses truecolor.
- **Glyphs**: `icons: "nerd"` needs a Nerd Font; `tps` and the meters use block characters.
