# @nicknisi/pi-llm-council

## 0.5.3

### Patch Changes

- 6bfdb8e: Project-local council config is now ignored in untrusted projects, failed councils are reported as tool errors (with a ✗ header and a "not run" synthesizer row), and malformed config files no longer crash the tool. The header spinner now stops when its tool call ends even if the component is discarded, and the README is updated to match current behavior.
- Updated dependencies [6bfdb8e]
  - @nicknisi/pi-shared@0.11.1

## 0.5.2

### Patch Changes

- 760fe48: Stop loading a second copy of pi at startup. pi loads pi-shared with a native import that can't see pi's module aliases, so pi-shared's own pi imports pulled a separate pi from disk (about 0.4s and 100MB per session, with its own keybindings and version). pi-shared no longer imports pi at runtime: subagents, workflows and llm-council hand it the running pi through the new `bindPiSdk()`, and unbound callers import pi lazily on first use.

  Breaking for direct pi-shared users: `SearchableSelectList` is no longer exported (it is now internal to pi-subagents, its only user), the unused `columns()` helper is gone, and `resolveContainedAgentResource()` now takes the agent dir as its first argument.

- Updated dependencies [760fe48]
  - @nicknisi/pi-shared@0.11.0

## 0.5.1

### Patch Changes

- Updated dependencies [9ec3ab2]
  - @nicknisi/pi-shared@0.10.1

## 0.5.0

### Minor Changes

- e434bdb: Show expand hints with the `keyText` pi passes to renderers, so they follow your configured keybindings. If `app.tools.expand` has no key, the hint is left out. Requires pi 1.5.0 or later.

### Patch Changes

- e434bdb: Ship `CHANGELOG.md` in the npm package so pi 1.5 can show what changed under "Extension Updates" after `pi update`.

## 0.4.7

### Patch Changes

- 0d6c783: Drop `uniqueItems` from the `llm_council` and `relay` tool schemas. OpenAI strict function schemas reject the keyword, which broke every request in GPT sessions with a 400. Duplicate council members are still rejected at runtime, and relay already ignores duplicate session IDs.

## 0.4.6

### Patch Changes

- a29e2a9: Fix the `llm_council` tool rendering the member/chairman progress tree twice while running. The tool header now shows only the spinner, and the live tree is drawn once by the result renderer. This also removes module-level progress state that concurrent council calls could share.

## 0.4.5

### Patch Changes

- Updated dependencies [fcb686c]
  - @nicknisi/pi-shared@0.10.0

## 0.4.4

### Patch Changes

- Updated dependencies [a9f4d1a]
- Updated dependencies [15ddcd3]
  - @nicknisi/pi-shared@0.9.0

## 0.4.3

### Patch Changes

- 4786506: recap: summarize the compacted context instead of the raw branch, cap each tool call's arguments at 200 characters, and don't recap again when nothing happened since the last recap; the minimum session length now counts only messages. llm-council: `/council` sends the chairman only the question and the member answers, not the whole conversation. btw: new optional `thinking` config field that overrides the session thinking level for side questions.
- Updated dependencies [245ee0f]
  - @nicknisi/pi-shared@0.8.1

## 0.4.2

### Patch Changes

- Updated dependencies [7801bfc]
  - @nicknisi/pi-shared@0.8.0

## 0.4.1

### Patch Changes

- Updated dependencies [c22cede]
- Updated dependencies [01de359]
- Updated dependencies [79ab2c6]
- Updated dependencies [db67986]
  - @nicknisi/pi-shared@0.7.0

## 0.4.0

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

## 0.3.1

### Patch Changes

- 561fad7: Declare `typebox` as a `"*"` peer dependency instead of a direct dependency so pi's host-provided copy is used (fixes the extension loader warning about duplicate runtime modules).
- Updated dependencies [561fad7]
  - @nicknisi/pi-shared@0.5.2

## 0.3.0

### Minor Changes

- 9a81443: Run `/council <question>` immediately with the current conversation as context. Bare `/council` asks once, shows the lineup, and runs on Enter without another confirmation. Show progress, support cancellation, and display the synthesis in chat. Keep configuration-only editing under `/council settings`, with session persistence and explicit global saves. Search all available models immediately, toggle members in a checklist, and choose a separate synthesizer. Add per-call member/chairman overrides and resolve ambiguous names through provider selection. Label failed partial synthesis as incomplete instead of hiding the error.

## 0.2.4

### Patch Changes

- 7c6a68d: Show cumulative token usage while subagents and council members are running, and expose live usage updates through the shared subagent runtime.
- Updated dependencies [7c6a68d]
  - @nicknisi/pi-shared@0.5.1

## 0.2.3

### Patch Changes

- Updated dependencies [4fff6f8]
  - @nicknisi/pi-shared@0.5.0

## 0.2.2

### Patch Changes

- Updated dependencies [9cd49ce]
  - @nicknisi/pi-shared@0.4.0

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
