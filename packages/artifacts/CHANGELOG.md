# @nicknisi/pi-artifacts

## 1.2.0

### Minor Changes

- ede2c77: Add an annotation + feedback loop to artifacts. Served artifact pages now carry an inert comment layer (injected at serve time, never written to the stored file): select text, comment, and submit to send the composed markdown back to the agent as a follow-up message. Comments persist to a `<slug>.annotations.json` sidecar and survive live reloads and restarts; stale comments (whose quoted text no longer appears) are flagged. New endpoints `PUT /api/annotations`, `POST /api/feedback`, and `POST /api/render` (GFM preview); markdown artifacts also write a `<slug>.md` source mirror for source-line references. `share` (clipboard and gist) bakes current comments into the shared file — highlights plus a read-only comments panel — with an `annotations: false` opt-out. Served artifact pages also carry a Share button (Copy image / Copy PDF / Copy file / Create gist link) via `POST /api/share`, so sharing no longer requires an agent round-trip. Image renders with the comments panel open; PDF prints with a Review comments section appended. New `pdf` share method on the tool as well.

## 1.1.0

### Minor Changes

- e4e2a96: Add a `share` action for artifacts: copy the self-contained HTML to the clipboard, reveal the file in the OS file manager, upload as a GitHub gist, or screenshot the rendered artifact to a PNG.

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
