# @nicknisi/pi-artifacts

## 1.0.2

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

## 1.0.1

### Patch Changes

- cdfbc22: Resolve user config through pi's `getAgentDir()` instead of hardcoding `~/.pi/agent`, so these extensions honor `PI_CODING_AGENT_DIR` and work under harnesses that relocate the agent dir. Behavior is unchanged when the variable is unset.

  `artifacts` resolves diff2html's stylesheet with a direct `import.meta.resolve(...)` call instead of `createRequire`, keeping it loadable under jiti and in single-file bundles.

  `chat-input` now supports prefixes of any cell width. The layout math previously assumed a 1-cell prefix, so a two-cell `prefix` (e.g. `❮❯`) overflowed the box by one cell and under-indented continuation lines. Rendering is unchanged for 1-cell prefixes.

- 648e6df: Add repository/homepage metadata, MIT license field, and oxfmt-canonical package.json formatting for npm provenance links.
