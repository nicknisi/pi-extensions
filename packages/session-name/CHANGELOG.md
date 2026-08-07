# @nicknisi/pi-session-name

## 0.1.3

### Patch Changes

- d1e7b44: Read config from the real agent dir instead of a hardcoded `~/.pi/agent`.

  Both packages built their config path from `os.homedir()`, so anyone running a
  non-default agent dir (`PI_CODING_AGENT_DIR`, or a harness that sets it) had
  their config silently ignored — and in recap's case, writes landed in the wrong
  place too. They now use `getAgentDir()`, like the other packages. recap also
  resolves the path per call, so a config it just wrote is visible to the next
  read.

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
