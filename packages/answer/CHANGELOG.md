# @nicknisi/pi-answer

## 0.3.1

### Patch Changes

- Updated dependencies [245ee0f]
  - @nicknisi/pi-shared@0.8.1

## 0.3.0

### Minor Changes

- 7801bfc: Optional classifier models. heads-up scores each automatic check with a classifier (TypeSafe's Jev by default) in shadow mode, logging the score with each event; `gateEnforce: true` skips checks below `gateThreshold`. answer shows a `? ctrl+. to answer` footer hint after replies a classifier judges to ask you questions. Both behave as before when no classifier is available. pi-shared adds `findClassifier`, `classifyBool`, and `DEFAULT_CLASSIFIERS`.

  heads-up also logs every check, with its side-request cost, and `/heads-up` shows the logged total, since these requests never reach the session cost. The event log keeps 2000 events instead of 500. answer defaults to `claude-haiku-4-5` then `claude-sonnet-5` for extraction instead of Fable 5 and Opus 5, and `/answer` no longer requires a session model.

### Patch Changes

- Updated dependencies [7801bfc]
  - @nicknisi/pi-shared@0.8.0

## 0.2.4

### Patch Changes

- b67617e: Fix system prompts being silently dropped on pi >=0.86: model calls now go through `ctx.modelRegistry.complete()`/`streamSimple()`, which accept `systemPrompt` and resolve auth. Requires pi >=0.86.0.

## 0.2.3

### Patch Changes

- Updated dependencies [561fad7]
  - @nicknisi/pi-shared@0.5.2

## 0.2.2

### Patch Changes

- aab5bad: Forward `env` from `getApiKeyAndHeaders()` to the side-model stream so providers that resolve endpoint placeholders from it (Cloudflare AI Gateway, Workers AI) stop 401ing.

  `btw` now builds its side-thread context from `buildContextEntries()` (compaction applied, with the summary carried as a leading message) instead of the raw branch, so long sessions no longer exceed the model window (`400 prompt is too long`).

## 0.2.1

### Patch Changes

- Updated dependencies [7c6a68d]
  - @nicknisi/pi-shared@0.5.1

## 0.2.0

### Minor Changes

- 5ec73b4: Make `/answer` extraction models configurable as an ordered `provider/model-id` fallback list in `~/.pi/agent/configs/answer.json`, preserving the existing Anthropic defaults.

### Patch Changes

- Updated dependencies [4fff6f8]
  - @nicknisi/pi-shared@0.5.0

## 0.1.5

### Patch Changes

- Updated dependencies [9cd49ce]
  - @nicknisi/pi-shared@0.4.0

## 0.1.4

### Patch Changes

- Updated dependencies [00958ee]
- Updated dependencies [1f032e3]
- Updated dependencies [00958ee]
- Updated dependencies [efef393]
  - @nicknisi/pi-shared@0.3.0

## 0.1.3

### Patch Changes

- Updated dependencies [cacb4cc]
- Updated dependencies [121a19d]
- Updated dependencies [c60bd34]
- Updated dependencies [0aabf31]
- Updated dependencies [0aabf31]
- Updated dependencies [cacb4cc]
- Updated dependencies [73c772e]
  - @nicknisi/pi-shared@0.2.0

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
- Updated dependencies [74e29ab]
  - @nicknisi/pi-shared@0.1.2

## 0.1.1

### Patch Changes

- 648e6df: Add repository/homepage metadata, MIT license field, and oxfmt-canonical package.json formatting for npm provenance links.
- Updated dependencies [648e6df]
  - @nicknisi/pi-shared@0.1.1
