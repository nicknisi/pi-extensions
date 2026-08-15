# @nicknisi/pi-answer

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
