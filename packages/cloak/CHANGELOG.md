# @nicknisi/pi-cloak

## 0.2.0

### Minor Changes

- ad165d6: Redact `bash` and `grep` results, not only `read`. A rule applies to them when the bash command names a file the rule covers (`cat .env`), when grep's `path`/`glob` matches, or always when the rule sets the new `global: true`. Patterns now run over the whole text with the `m` flag, so multi-line secrets such as PEM blocks can match while `^`/`$` stay per-line. A rule with an invalid regex is skipped and reported instead of disabling every rule. A config file that exists but can't be parsed now withholds tool output (fails closed); a missing config file still passes output through. Errors are written to stderr when there's no UI.

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

- 648e6df: Add repository/homepage metadata, MIT license field, and oxfmt-canonical package.json formatting for npm provenance links.
