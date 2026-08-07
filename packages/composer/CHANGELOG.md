# @nicknisi/pi-composer

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
