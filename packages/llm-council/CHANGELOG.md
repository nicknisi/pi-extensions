# @nicknisi/pi-llm-council

## 0.2.1

### Patch Changes

- Updated dependencies [00958ee]
- Updated dependencies [1f032e3]
- Updated dependencies [00958ee]
- Updated dependencies [efef393]
  - @nicknisi/pi-shared@0.3.0

## 0.2.0

### Minor Changes

- 6634463: Spawn council members and the chairman through `@nicknisi/pi-shared`'s in-process subagent runtime instead of headless `pi` subprocesses. Behavior changes: children are hermetic — `extensions: null` / `skills: null` no longer inherit ambient resources (both mean "none"; named resources still load, containment-checked); member text is the child's final assistant message rather than a concatenation of all assistant messages (fixes wrong output when members use tools); spawning is refused inside pi-subagents child sessions (`PI_SUBAGENT_DEPTH`/`PI_SUBAGENT_CHILD`).

### Patch Changes

- Updated dependencies [cacb4cc]
- Updated dependencies [121a19d]
- Updated dependencies [c60bd34]
- Updated dependencies [0aabf31]
- Updated dependencies [0aabf31]
- Updated dependencies [cacb4cc]
- Updated dependencies [73c772e]
  - @nicknisi/pi-shared@0.2.0

## 0.1.3

### Patch Changes

- d1e7b44: Security: contain council `extensions`/`skills` names to the agent dir.

  Council `extensions` and `skills` entries are bare resource names resolved
  under the user's own agent dir, but they can be supplied by
  `<cwd>/.pi/configs/llm-council.json` — untrusted repository input.
  `buildExecArgs()` passed them straight through `path.join`, so a crafted name
  such as `../../../proc/self/cwd/.pi/payload` collapsed into an arbitrary
  filesystem path handed to pi as `-e`/`--skill`, loading repo-controlled code
  outside pi's project-trust gate. Opening a council in a hostile repository was
  enough to trigger it.

  Names must now be contained bare names — no path separators, no `..` — and the
  resolved path is verified to stay under the agent dir. Anything else is skipped
  with a diagnostic. Legitimate names are unaffected.

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
