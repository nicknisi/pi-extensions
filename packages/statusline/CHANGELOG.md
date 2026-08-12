# @nicknisi/pi-statusline

## 0.2.0

### Minor Changes

- 4fff6f8: Scope the default fleet command, shortcut, tool list, and footer indicator to active subagents owned by the current Pi session, with explicit `all` access to persisted machine-wide history. Propagate owner-session metadata through codemode and workflows without enabling session mirrors. Add a global statusline `hiddenStatuses` denylist for suppressing extension-provided footer segments.

### Patch Changes

- Updated dependencies [4fff6f8]
  - @nicknisi/pi-shared@0.5.0

## 0.1.7

### Patch Changes

- 8a7fabd: Guard the optional `claude-notify` spawn so a missing binary no longer kills pi with an uncaught `ENOENT`.

  The `agent_end` handler spawned `claude-notify waiting <session> <pane>` with `detached: true` and `stdio: 'ignore'`, then immediately `.unref()`'d the returned `ChildProcess` without attaching an `error` listener. When `claude-notify` is not on `PATH`, Node emits `ENOENT` asynchronously on the child's `error` event; with no listener that escalates to an uncaught exception and takes the whole pi process down. `stdio: 'ignore'` does not suppress spawn `error` events.

  Attach an empty `error` listener so the failure is swallowed: behavior is unchanged when `claude-notify` exists, and a missing optional notifier can no longer crash pi.

## 0.1.6

### Patch Changes

- e934231: Render extension statuses (`ctx.ui.setStatus()`) in the footer and cap the context bar at 20 columns. Replacing pi's footer meant every extension's status indicator was silently dropped; each status now renders as its own segment with whitespace folded and SGR colors left intact.

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

- Updated dependencies [74e29ab]
  - @nicknisi/pi-shared@0.1.2

## 0.1.1

### Patch Changes

- 648e6df: Add repository/homepage metadata, MIT license field, and oxfmt-canonical package.json formatting for npm provenance links.
- Updated dependencies [648e6df]
  - @nicknisi/pi-shared@0.1.1
