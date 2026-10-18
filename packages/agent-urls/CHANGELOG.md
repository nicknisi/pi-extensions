# @nicknisi/pi-agent-urls

## 0.2.1

### Patch Changes

- Updated dependencies [c22cede]
- Updated dependencies [01de359]
- Updated dependencies [79ab2c6]
- Updated dependencies [db67986]
  - @nicknisi/pi-shared@0.7.0

## 0.2.0

### Minor Changes

- b67617e: Adopt pi 1.x tool metadata. Rarely used tools (`list_agent_runs`, `read_agent_url`, `ast_search`, `ast_rewrite`, `codesearch`, `codefetch`, `llm_council`, `fleet`, `workflow`) register as `deferred`, so they stay out of the system prompt when the built-in `tool_search` is on; without it they are declared directly as before (new `declareUnlessSearchable` helper in pi-shared). Every tool in these packages gains `annotations` for permission extensions (worst-case hints for `dispatch` and `workflow`), and `list_agent_runs` returns `structuredContent` for codemode scripts.
- 17c4f48: Subagent children now use the parent session's model registry: providers registered at runtime (such as a Cloudflare AI Gateway provider) carry over with their auth and headers. A task with no model runs on the parent's current model. New `parent` option on `createSubagentRuntime`; llm-council members get the same registry.

  New `PI_SUBAGENTS_DIR` env var moves every file the subagent runtime writes (run records, patches, worktrees, session mirrors, workflow runs) under one root, and agent-urls reads run records from there. Unset, paths are unchanged.

### Patch Changes

- Updated dependencies [b67617e]
- Updated dependencies [b67617e]
- Updated dependencies [b67617e]
- Updated dependencies [17c4f48]
  - @nicknisi/pi-shared@0.6.0

## 0.1.3

### Patch Changes

- 73c772e: Repoint agent-urls at the first-party runtime's persisted run records (`~/.pi/agent/subagent-runs/<namespace>/<runId>.json`) instead of nicobailon/pi-subagents' state dirs (session JSONLs, tmpdir async/chain dirs, artifact dirs — all gone). URIs are now `agent://<namespace>/<runId>[/output|error|raw]`; `history://` transcript reading is dropped because records carry bounded output, not session files.
- cacb4cc: Repoint agent-urls at the first-party runtime's persisted run records (`~/.pi/agent/subagent-runs/<namespace>/<runId>.json`) instead of nicobailon/pi-subagents' state dirs (session JSONLs, tmpdir async/chain dirs, artifact dirs — all gone). URIs are now `agent://<namespace>/<runId>[/output|error|raw]`; `history://` transcript reading is dropped because records carry bounded output, not session files.

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
