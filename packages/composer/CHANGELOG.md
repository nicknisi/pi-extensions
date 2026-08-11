# @nicknisi/pi-composer

## 0.4.0

### Minor Changes

- 1847cbd: Add an extension API for the border inlay over pi's shared event bus (`pi.events`). Other extensions can push label text with `pi.events.emit('composer:set-label', { text })` (absent/empty text clears it, falling back to the session name), and composer emits `composer:label-request` on every session start so producers can re-push regardless of extension load order. Pushed labels go through the same format/colour/position/truncation pipeline as the session name.
- ccff6ab: Inlay the session name in the composer's border when the session has one (set via `/name`, `--name`, or the session-name extension's auto-naming). Long names are truncated with an ellipsis and the inlay hides when the composer is too narrow. New composer.json options: `sessionName` (default `true`), `sessionNameColor` (default `"muted"`), `sessionNamePosition` (`"right"` | `"left"`), `sessionNameFormat` (surround template, default `"─ {name} ─"`), `sessionNameMaxWidth` (cell cap, default `0` = fit the rule), and `sessionNameBorder` (`"top"` | `"bottom"`).

## 0.3.1

### Patch Changes

- d448614: Put the cursor at the end of a message recalled from history. pi-tui places the cursor at the start of an entry recalled with Up, so typing prepends to your own sentence; composer now overrides `navigateHistory` to move the cursor to the end after a successful Up recall. Down navigation, draft restoration, and boundary no-ops (Up at the oldest entry) keep their original cursor behavior.

## 0.3.0

### Minor Changes

- dae128d: Rename package: `@nicknisi/pi-chat-input` is now `@nicknisi/pi-composer`. Pure rename — no behavior changes. Breaking for existing installs: the config file moves from `configs/chat-input.json` to `configs/composer.json` (rename your file), the command is now `/composer`, and installs should point at `packages/composer`. The old npm package will be deprecated in favor of this one; version history carries over.

## 0.2.0

### Minor Changes

- d82ce71: Add working-state whimsy: the prefix glyph animates as a spinner and the border glows (pulse or shimmer) while pi is thinking, driven by `agent_start`/`agent_settled`. Nine built-in spinner presets (`spinnerStyle`: dots, disc, moon, star, orbit, corners, triangle, scanner, mini-scanner), each with a tuned default interval, plus custom frames via `spinnerFrames`. Fully configurable via `spinner`, `spinnerStyle`, `spinnerFrames`, `spinnerIntervalMs`, `spinnerColor`, `glow`, `glowStyle`, `glowColor`, and `glowPeriodMs` in `chat-input.json`. `spinnerColor` and `glowColor` also accept the special value `"rainbow"`, which hue-rotates once per `rainbowPeriodMs`.

  The pulse glow anchors on `borderColor` (not the focus-adjusted border), so the default `border`→`accent` pulse is visible out of the box even with `focusIndicator` on. New `/chat-input` command reloads `chat-input.json` in place (no restart) and previews the working animation for ~3 seconds; invalid JSON is now reported at startup (warning) and on reload (error, previous config kept) instead of silently falling back to defaults.

## 0.1.2

### Patch Changes

- 74e29ab: Publish compiled JS alongside the TypeScript sources.

  `exports` now resolves to `./dist/index.js` and `./dist/index.d.ts`, while the
  `pi` manifest keeps pointing at `./index.ts`. pi is unaffected — it loads
  extensions through jiti, which transpiles TypeScript on the fly, and local path
  installs still need no build step.

  This fixes every _other_ consumer. Node refuses to strip types inside
  `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so anything
  `tsc`-built that imported one of these packages crashed at runtime on the raw
  sources. Bundlers and type resolution get a proper entry point too.

- 25787d2: Compile under `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Unchecked indexed reads are now narrowed or explicitly asserted where the index is in range by construction, and optional properties that can legitimately hold `undefined` declare it. Packages ship raw TypeScript, so this also affects how consumers typecheck against them; runtime behavior is unchanged.

## 0.1.1

### Patch Changes

- cdfbc22: Resolve user config through pi's `getAgentDir()` instead of hardcoding `~/.pi/agent`, so these extensions honor `PI_CODING_AGENT_DIR` and work under harnesses that relocate the agent dir. Behavior is unchanged when the variable is unset.

  `artifacts` resolves diff2html's stylesheet with a direct `import.meta.resolve(...)` call instead of `createRequire`, keeping it loadable under jiti and in single-file bundles.

  `chat-input` now supports prefixes of any cell width. The layout math previously assumed a 1-cell prefix, so a two-cell `prefix` (e.g. `❮❯`) overflowed the box by one cell and under-indented continuation lines. Rendering is unchanged for 1-cell prefixes.

- 648e6df: Add repository/homepage metadata, MIT license field, and oxfmt-canonical package.json formatting for npm provenance links.
