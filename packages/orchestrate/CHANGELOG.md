# @nicknisi/pi-orchestrate

## 0.2.1

### Patch Changes

- abe59ff: Each session now keeps its `/goal` and `/loop` state in its own file (`.pi-goal/<session>.json`), so another session in the same folder can no longer overwrite or delete it. A self-paced `/loop` no longer runs a duplicate iteration after auto-compaction. An existing `.pi-goal/state.json` from an older version is ignored.

## 0.2.0

### Minor Changes

- b67617e: Move to public pi APIs. orchestrate: the goal evaluator is a single `ctx.modelRegistry.streamSimple()` call instead of a sub-session built on a private runtime, and self-paced loops tick from `agent_settled` instead of a 1.5s timer (needs pi >=0.87). compact-tools: uses `pi.registerToolRenderer()` instead of patching `ToolExecutionComponent` (needs pi >=1.0.1; collapsed rows no longer hide inline images). adr: writes a `decision_records` system prompt section instead of replacing the whole prompt each run, keeping prompt caching intact (needs pi >=0.86).

### Patch Changes

- b67617e: Accept an evaluator verdict wrapped in a single-line ```json fence instead of pausing the goal.

## 0.1.4

### Patch Changes

- 74e4e9e: Make /goal completion evidence-aware using the current model, without an additional AI service. Validate cited session evidence, distinguish unverified results from unfinished work, and pause on evaluator failures or bounded continuation limits. Add /goal resume, persist paused state, and cancel stale evaluations when goals or sessions change.

## 0.1.3

### Patch Changes

- 2d1edcd: `/goal stop` (and clear aliases) now stops a running `/loop` too — previously it replied "No goal set" while a loop kept re-firing, which read as a goal that couldn't be stopped. Clearing also aborts the in-flight turn so the stop is immediate.

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

## 0.1.1

### Patch Changes

- 648e6df: Add repository/homepage metadata, MIT license field, and oxfmt-canonical package.json formatting for npm provenance links.
