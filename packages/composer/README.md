# @nicknisi/pi-composer

Replaces pi's input editor with a configurable boxed input rendered inside pi's
TUI. All native editor features — cursor movement, history, autocomplete,
paste — work normally inside the box. It also implements paste-again-to-expand:
when a collapsed `[paste #N ...]` marker is present in the editor, pasting the
same content again expands it inline so you can see and edit the actual text.

Evolved from the earlier single-file `box-editor.ts`: rendering is now
config-driven and the paste-expand behavior was merged in from the former
standalone `paste-expand.ts` so the two features don't fight over
`setEditorComponent` (last call wins).

## What it adds

- **Custom editor component** via `ctx.ui.setEditorComponent` (no tools, no
  keybindings, no custom entry types).
- **`/composer` command**: reloads `composer.json` without restarting pi
  and previews the working animation for ~3 seconds.
- **Events hooked**: `session_start` (installs the editor component, reads
  the session name), `session_info_changed` (tracks renames for the inlay),
  `agent_start` / `agent_settled` (drive the working-state animations), and
  `session_shutdown` (removes it and tears down focus tracking and animation
  timers). TUI mode only; all handlers no-op when `ctx.mode !== "tui"`.
- **Paste-again-to-expand**: overrides the editor's `handlePaste` to detect
  when an incoming paste matches an already-collapsed paste's stored content;
  if the marker `[paste #N ...]` is still in the buffer, the marker is replaced
  with the real content and the paste registry is renumbered to stay dense.
- **History recall puts the cursor at the end**: pi-tui places the cursor at
  the _start_ of a message recalled with Up, so typing prepends to your own
  sentence. Composer overrides `navigateHistory` to move the cursor to the end
  after a successful Up recall. Down, draft restoration, and boundary no-ops
  (Up at the oldest entry) are untouched.
- **Extension API** over `pi.events`: other extensions can push their own text
  into the border inlay — see [Extension API](#extension-api).

## Features

- **Session-name inlay**: when the session has a name, it is inlaid in the
  border (default right end of the top rule). Position, surround glyphs, max
  width, and which border are all configurable:

  ```text
  sessionNamePosition "right", sessionNameFormat "─ {name} ─" (defaults):
  ╭──────────────── refactor auth ─╮

  sessionNamePosition "left", sessionNameFormat "[ {name} ]":
  ╭[ refactor auth ]───────────────╮
  ```

- **Rounded or square box**: `╭╮│╰╯` (default, preserves the original look) or `┌┐│└┘`
- **Configurable prefix glyph** on the first body line (default `❯`); continuation lines get a space so content aligns
- **Theme-aware colors**: border and prefix accept any theme colour token or hex value
- **Boxed / unboxed**: full box with side borders, or top/bottom horizontal rules only
- **Menu outside box**: slash-menu lines render below the box, with configurable gap and indent
- **Scroll indicators**: pi's stock `↑ N more` / `↓ N more` indicators are detected in the stock borders and re-embedded in the replacement borders
- **Responsive**: below a minimum width (see caveats) the extension defers to pi's stock editor rendering
- **Focus indicator**: border switches colour when the tmux pane holding this session has terminal focus (requires tmux `focus-events on`)
- **Spinner prefix**: while pi is working, the prefix glyph animates as a spinner — pick from built-in presets or define your own frames (configurable speed and colour, including `"rainbow"`)
- **Border glow**: while pi is working, the border either _pulses_ (breathes between the border colour and a glow colour) or _shimmers_ (a highlight sweeps along the top/bottom rules)

## Extension API

Other extensions can replace the border-inlay text over pi's shared event bus
(`pi.events`), without importing anything from this package:

```ts
// Push a label (any non-empty string):
pi.events.emit('composer:set-label', { text: `⏱ ${elapsed}` });

// Clear it (falls back to the session name):
pi.events.emit('composer:set-label', {});
```

The pushed text takes precedence over the session name and goes through the
same formatting pipeline — `sessionNameFormat`, `sessionNameColor`, position,
border, and truncation all apply. The override is cleared on every session
start so a stale label never leaks across sessions.

Because extension load order is not guaranteed, composer emits
`composer:label-request` on every `session_start`; producers should respond to
it (and to whatever changes their own state) with `composer:set-label`:

```ts
pi.events.on('composer:label-request', () => {
  pi.events.emit('composer:set-label', { text: currentLabel() });
});
```

## Install

```sh
pi install /path/to/pi-extensions/packages/composer
```

## Usage

Once installed, the editor component is installed automatically at session
start. Editing, history, autocomplete, and paste behave as usual inside the
box. Run `/composer` after editing the config to reload it in place and
preview the spinner/glow without sending a prompt.

Paste-again-to-expand works automatically too: pi collapses large pastes
(>10 lines or >1000 chars) into `[paste #N +X lines]` markers; paste the same
content a second time while the marker is present and it expands inline. The
comparison replicates pi-tui's paste cleanup (CSI-u Ctrl+letter decoding,
CRLF→LF, tabs→4 spaces, non-printable stripping) and also tolerates a single
leading space that pi prepends to path-like pastes.

Layout (boxed):

```
╭──────────────────────────╮
│ ❯ <content>               │
│   <content continued>     │
╰──────────────────────────╯
<autocomplete menu>
```

## Configuration

Config is read at extension load from
`~/.pi/agent/configs/composer.json`; run `/composer` to reload it without
restarting pi (it also previews the working animation). The path follows pi's
agent dir, so it moves with `PI_CODING_AGENT_DIR` if you set it. A missing
file means all defaults; invalid JSON is reported (at startup via a warning,
on `/composer` via an error) and the previous/default config is kept. Copy
`composer.example.json` from this package as a starting point.

```json
{
  "boxedView": true,
  "boxPadX": 1,
  "menuGap": 0,
  "extraMenuIndent": 1,
  "borderColor": "border",
  "prefix": "❯",
  "prefixColor": "accent",
  "corners": "rounded",
  "focusIndicator": true,
  "focusedBorderColor": "accent",
  "sessionName": true,
  "sessionNameColor": "muted",
  "sessionNamePosition": "right",
  "sessionNameFormat": "─ {name} ─",
  "sessionNameMaxWidth": 0,
  "sessionNameBorder": "top",
  "spinner": true,
  "spinnerStyle": "dots",
  "spinnerColor": "accent",
  "glow": true,
  "glowStyle": "pulse",
  "glowColor": "accent",
  "glowPeriodMs": 2000
}
```

| Option                | Type                    | Default        | Description                                                                                                                   |
| --------------------- | ----------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `boxedView`           | `boolean`               | `true`         | `true` = full box with side borders. `false` = top/bottom horizontal rules only.                                              |
| `boxPadX`             | `number`                | `1`            | Horizontal padding inside the box (and around the prefix).                                                                    |
| `menuGap`             | `number`                | `0`            | Blank lines between the bottom border and the slash-menu.                                                                     |
| `extraMenuIndent`     | `number`                | `1`            | Extra indent (spaces) for slash-menu lines.                                                                                   |
| `borderColor`         | `string`                | `"border"`     | Theme colour token **or** hex colour (`"#ff6600"`) for the box border.                                                        |
| `prefix`              | `string`                | `"❯"`          | Prefix glyph shown on the first body line.                                                                                    |
| `prefixColor`         | `string`                | `"accent"`     | Theme colour token **or** hex colour for the prefix.                                                                          |
| `corners`             | `"rounded" \| "square"` | `"rounded"`    | `rounded` = `╭╮│╰╯`, `square` = `┌┐│└┘`. Any other value falls back to `rounded`.                                             |
| `focusIndicator`      | `boolean`               | `true`         | Track terminal focus (DECSET 1004) and restyle the border when this pane is focused. Requires `focus-events on` in tmux.      |
| `focusedBorderColor`  | `string`                | `"accent"`     | Border colour while the pane is focused; `borderColor` is used when unfocused.                                                |
| `sessionName`         | `boolean`               | `true`         | Inlay the session name in the border when the session has one (set via `/name`, `--name`, or the session-name extension).     |
| `sessionNameColor`    | `string`                | `"muted"`      | Theme colour token **or** hex colour for the session name inlay.                                                              |
| `sessionNamePosition` | `"left" \| "right"`     | `"right"`      | Which end of the border the name sits at. `left` shares that end with the scroll indicator when the input overflows.          |
| `sessionNameFormat`   | `string`                | `"─ {name} ─"` | Surround template; must contain `{name}`. The surrounding glyphs render in the border colour, the name in `sessionNameColor`. |
| `sessionNameMaxWidth` | `number`                | `0`            | Cell cap for the name before truncating with `…`; `0` = fit within the rule, keeping 8 cells of plain border.                 |
| `sessionNameBorder`   | `"top" \| "bottom"`     | `"top"`        | Which border (top or bottom rule) carries the name.                                                                           |
| `spinner`             | `boolean`               | `true`         | Animate the prefix as a spinner while pi is working (between `agent_start` and `agent_settled`).                              |
| `spinnerStyle`        | `string`                | `"dots"`       | Built-in spinner preset — see [Spinner presets](#spinner-presets). Unknown names fall back to `dots`.                         |
| `spinnerFrames`       | `string[]`              | —              | Custom spinner frames; overrides `spinnerStyle`. Any cell width — the prefix slot is sized to the widest frame.               |
| `spinnerIntervalMs`   | `number`                | per preset     | Milliseconds per spinner frame. Defaults to the active preset's tuned interval.                                               |
| `spinnerColor`        | `string`                | `"accent"`     | Theme colour token, hex colour, or `"rainbow"` (hue rotates while spinning).                                                  |
| `glow`                | `boolean`               | `true`         | Animate the border while pi is working.                                                                                       |
| `glowStyle`           | `"pulse" \| "shimmer"`  | `"pulse"`      | `pulse` breathes the whole border toward `glowColor`; `shimmer` sweeps a highlight along the top/bottom rules.                |
| `glowColor`           | `string`                | `"accent"`     | Theme colour token, hex colour, or `"rainbow"` the glow animates toward.                                                      |
| `glowPeriodMs`        | `number`                | `2000`         | Milliseconds per glow cycle (one full pulse breath or one shimmer sweep).                                                     |
| `rainbowPeriodMs`     | `number`                | `1200`         | Milliseconds per full hue rotation when a colour is set to `"rainbow"`.                                                       |

### Spinner presets

Each preset has a tuned default interval; set `spinnerIntervalMs` to override.

| Preset         | Frames                       | Interval | Notes                                                                                              |
| -------------- | ---------------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `dots`         | `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`        | 80ms     | Classic braille dots (default).                                                                    |
| `disc`         | `⣾ ⣽ ⣻ ⢿ ⡿ ⣟ ⣯ ⣷`            | 90ms     | Dense braille disc with an orbiting gap.                                                           |
| `moon`         | `🌑 🌒 🌓 🌔 🌕 🌖 🌗 🌘`    | 90ms     | Moon phases. Emoji — widens the prefix slot to 2 cells.                                            |
| `star`         | `✶ ✸ ✹ ✺ ✹ ✸`                | 90ms     | Twinkling star — flares and dims.                                                                  |
| `orbit`        | `◜ ◠ ◝ ◞ ◡ ◟`                | 80ms     | A dot orbiting a circle.                                                                           |
| `corners`      | `▖ ▘ ▝ ▗`                    | 120ms    | A quarter-block bouncing around the cell's corners.                                                |
| `triangle`     | `◢ ◣ ◤ ◥`                    | 120ms    | A spinning filled triangle.                                                                        |
| `scanner`      | `●····· … ·····● …` (bounce) | 60ms     | KITT scanner — comet with a fading tail. **6 cells wide**, so the idle prefix slot is 6 cells too. |
| `mini-scanner` | `●·· ·●· ··● ·●·`            | 120ms    | Scanner's little sibling — 3 cells, no tail.                                                       |

Define your own with `spinnerFrames` (any array of non-empty strings; it takes
precedence over `spinnerStyle`):

```json
{ "spinnerFrames": ["◐", "◓", "◑", "◒"], "spinnerIntervalMs": 100 }
```

The prefix slot is sized to the widest frame of the active spinner (idle `❯`
included), so wide frames permanently indent the input — the layout never
shifts when the agent starts or stops.

### Colour tokens

Any valid theme colour token works. See your active theme in
`~/.pi/agent/themes/` or via `/settings → Theme` for available tokens
(`border`, `accent`, `text`, `muted`, `success`, `error`,
`customMessageLabel`, …). Hex values must be 6-digit `#rrggbb`; invalid values
fall back to the uncoloured text. Hex takes precedence over theme tokens in
`applyColor`.

`spinnerColor` and `glowColor` additionally accept `"rainbow"`: a truecolor
hue rotation completing one full spectrum lap per `rainbowPeriodMs`. A rainbow
`glowColor` makes the pulse breathe toward a continuously rotating hue (and
the shimmer highlight cycle colours).

The pulse anchors on `borderColor` (not the focus-adjusted border), so the
default `border`→`accent` pulse is visible even while the pane is focused and
the resting border is already `accent`. If you set `glowColor` equal to
`borderColor`, the pulse has nothing to breathe toward and is invisible —
pick two colours that differ.

No environment variables are used.

## Dependencies

Peer dependencies (`*`):

- `@earendil-works/pi-coding-agent` — `ExtensionAPI`, `ExtensionContext`,
  `CustomEditor`, `KeybindingsManager`, `Theme`, `ThemeColor` types; the
  `session_start` / `session_shutdown` events; `ctx.ui.setEditorComponent`.
- `@earendil-works/pi-tui` — `TUI` and `EditorTheme` types, `visibleWidth`
  for width arithmetic over ANSI-styled strings, and `tui.addInputListener` /
  `tui.requestRender` for focus tracking.

No npm runtime dependencies; `node:fs` / `node:os` / `node:path` only.

## Caveats

- **pi-tui internals**: the paste-expand and history-cursor features reach into
  `Editor` privates at runtime (`state`, `pastes`, `pasteCounter`,
  `historyIndex`, `pushUndoSnapshot`, `cancelAutocomplete`,
  `exitHistoryBrowsing`, `setCursorCol`, `moveToLineEnd`) and override the
  TS-private `handlePaste` and `navigateHistory` (compile-time private,
  runtime-accessible). It
  also hard-codes pi's paste-marker format (`[paste #N +X lines]` /
  `[paste #N X chars]`) and replicates pi-tui's paste cleanup and registry
  renumbering. Any change to pi-tui's paste handling or marker format can
  break this.
- **Stock-render parsing**: the boxed renderer calls `super.render()` and then
  re-wraps its output, detecting pi's solid `─` borders and `↑/↓ N more` scroll
  indicators by string matching. If pi-tui changes how the stock editor renders
  borders or scroll indicators, the box layout will misdetect sections.
- **Narrow terminals**: if `width < 5 + BOX_PAD_X * padMultiplier`
  (`padMultiplier` is 3 boxed, 1 unboxed) or the stock render produces fewer
  than 2 lines, the component falls back to pi's stock rendering.
- **Focus tracking (DECSET 1004)**: pi itself never enables focus reporting, so
  the extension enables it (`\x1b[?1004h`) and installs a `process.on("exit")`
  hook to disable it — otherwise the shell inherits a mode that spews `[I`/`[O`
  into the prompt. Shutdown hooks also disable it. If the process is killed
  with a signal that bypasses the exit hook, the terminal can be left in
  focus-reporting mode.
- **tmux**: the focus indicator only changes state if tmux has
  `focus-events on` (and the outer terminal passes focus events through).
  Outside tmux it works only if the terminal itself emits CSI I / CSI O.
- **Config validation is shallow**: bad JSON is reported and numeric/enum
  fields are range-checked, but wildly wrong types for unchecked string fields
  (e.g. a number for `prefix`) may throw at render time.
- **Reload doesn't rebuild the editor**: `/composer` mutates the live config
  that render code reads, which covers every documented key. A key that only
  takes effect at component construction would need a restart (none currently
  do).
- **setEditorComponent conflicts**: any other extension calling
  `setEditorComponent` after this one will replace the editor (last call wins).
- **Pulse needs truecolor**: the pulse glow interpolates RGB between
  `borderColor` and `glowColor`. Both endpoints must resolve to RGB —
  hex values always do; theme tokens only if the theme emits truecolor
  (`38;2;r;g;b`) sequences. If either endpoint can't be resolved, the border
  falls back to a steady `glowColor` while working. Shimmer has no such
  requirement.
- **Animation cost**: while pi is working, a single timer requests a TUI
  re-render every `spinnerIntervalMs` (or 80ms for glow-only). Idle sessions
  have no timer running.
