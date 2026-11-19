# @nicknisi/pi-stash

## 0.2.2

### Patch Changes

- 6bfdb8e: Auto-restore now only happens after you submit a prompt from the editor, not when another extension starts a run, and the extension is now inactive outside the TUI so RPC sessions can no longer claim and lose stashed drafts. The README install instructions now use the npm package.

## 0.2.1

### Patch Changes

- e434bdb: Ship `CHANGELOG.md` in the npm package so pi 1.5 can show what changed under "Extension Updates" after `pi update`.

## 0.2.0

### Minor Changes

- 62b5ccd: Save stashed drafts per working directory, so they survive `/reload`, restarts and new sessions instead of living only in memory. Each draft is its own file, written atomically and flushed to disk; restoring claims a draft by deleting its file, so two windows never restore the same one and no lock is needed. The stack keeps the newest 10 drafts, unreadable draft files are left alone, and the widget preview drops control characters. Sending a message only auto-restores drafts from the current session; `ctrl+s` restores drafts from any window in the directory.

## 0.1.5

### Patch Changes

- 5110593: Use Ctrl-S for stash and restore, leaving Ctrl-Shift-S available for pi-web-access. Document how to move Pi's built-in save and session-sort shortcuts in keybindings.json.

## 0.1.4

### Patch Changes

- d6c0542: Use Ctrl-S for stash and restore, leaving Ctrl-Shift-S available for pi-web-access. Document how to move Pi's built-in save and session-sort shortcuts in keybindings.json.

## 0.1.3

### Patch Changes

- 720e3dc: Move the stash/restore shortcut from Ctrl+S to Ctrl+Shift+S to avoid Pi's built-in shortcut conflict warning. Update the widget hint to match.

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
