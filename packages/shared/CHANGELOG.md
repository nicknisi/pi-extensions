# @nicknisi/pi-shared

## 0.9.0

### Minor Changes

- a9f4d1a: Subagents are durable. A dispatch run cut off by pi quitting, reloading, switching sessions, or crashing is marked interrupted instead of cancelled, and its worktree is kept. Reopening that session resumes it under the same run id, from its own transcript and in its worktree. Its answer lands in the transcript as a `Resumed subagent … completed` notice, and `/fleet all` shows interrupted runs as `interrupted`. Esc and `fleet` cancel still cancel for good.

  shared: a child with a `parentSession` now writes its pi session file as it runs instead of mirroring it at the end, which removes the exported `writeSessionMirror`. Such runs store their spawn options on `RunRecord.resume`. Aborting with the new `HOST_EXIT` reason marks them `interrupted`, and the new `runtime.resumeDetached()` continues them. The startup sweep marks durable ghosts interrupted (keeping their worktree), sets `hostPid` while a run is still queued so queued ghosts are reaped too, and no longer reaps runs owned by another live pi process.

### Patch Changes

- 15ddcd3: Workflows cut off by pi quitting, reloading, switching sessions, or crashing relaunch on their own when you reopen the session that started them. Finished agents replay from the journal; only the agent that was cut off, and those after it, run again. The result arrives as a `Resumed workflow …` message. `run.json` now records the owning session and pi's process id, and a stop caused by the session ending is marked `interrupted` rather than plain `stopped`. `workflow stop` still stops for good.

  shared: export `pidAlive(pid)`.

## 0.8.1

### Patch Changes

- 245ee0f: Subagent worktree runs no longer lose work. Timeouts, stalls and turn or tool-call budget limits now capture the patch. Only a caller cancel or host shutdown removes the worktree right away. Setup failures (unknown model, a throw while creating the session) remove the worktree and mark the run failed instead of leaking it as `running`. Patches are written by git directly with `--binary`, so diffs over 1 MB and binary edits are captured and apply cleanly.

## 0.8.0

### Minor Changes

- 7801bfc: Optional classifier models. heads-up scores each automatic check with a classifier (TypeSafe's Jev by default) in shadow mode, logging the score with each event; `gateEnforce: true` skips checks below `gateThreshold`. answer shows a `? ctrl+. to answer` footer hint after replies a classifier judges to ask you questions. Both behave as before when no classifier is available. pi-shared adds `findClassifier`, `classifyBool`, and `DEFAULT_CLASSIFIERS`.

  heads-up also logs every check, with its side-request cost, and `/heads-up` shows the logged total, since these requests never reach the session cost. The event log keeps 2000 events instead of 500. answer defaults to `claude-haiku-4-5` then `claude-sonnet-5` for extraction instead of Fable 5 and Opus 5, and `/answer` no longer requires a session model.

## 0.7.0

### Minor Changes

- c22cede: Fast mode now reaches subagent and workflow children: they follow the session's `/fast` toggle and share its rate-limit cooldown. The shared runtime gains `childExtensions()`, a registry of inline extensions loaded into every child.
- 01de359: Fan-outs share one prompt-cache write: matching workflow agents that start together wait (at most 5 seconds) for the first one's response to start, so they read its cached prefix instead of each writing their own. The shared runtime gains an `onResponseStart` callback.
- 79ab2c6: Workflow agents that stop producing output for 5 minutes (tool time excluded) restart from the same prompt, up to 5 times. Agents with a `schema` are now told the JSON Schema, and an invalid answer is corrected in the same session before failing. The shared runtime gains `stallMs` and a `stalled` failure kind.
- db67986: Workflows run up to 16 agents at once by default (fewer on small machines; `PI_WORKFLOW_MAX_CONCURRENT` sets 1–256). A failed `agent()` inside `parallel()`/`pipeline()` now becomes `null` instead of failing the whole wave, and runs are capped at 1,000 agents and 4,096 items per call.

## 0.6.0

### Minor Changes

- b67617e: shared: remove `hideLabeledSection`, `scheduleHideLabeledSection`, `clearHideTimers`, and `RequestRenderable`; their only use was pi's `[Themes]` banner, removed in pi 0.99. claude-design: setup and the `design` skill target pi's built-in MCP support (`!command` headers, `mcp__claude_design__*` tool names) instead of pi-mcp-adapter.
- b67617e: Remove `getModelProvider` (use `ctx.modelRegistry.complete()`/`streamSimple()` instead). Subagent runs that never produced an assistant turn are no longer mirrored as pi sessions (pi 1.0 started writing the session file on the first user message).
- b67617e: Adopt pi 1.x tool metadata. Rarely used tools (`list_agent_runs`, `read_agent_url`, `ast_search`, `ast_rewrite`, `codesearch`, `codefetch`, `llm_council`, `fleet`, `workflow`) register as `deferred`, so they stay out of the system prompt when the built-in `tool_search` is on; without it they are declared directly as before (new `declareUnlessSearchable` helper in pi-shared). Every tool in these packages gains `annotations` for permission extensions (worst-case hints for `dispatch` and `workflow`), and `list_agent_runs` returns `structuredContent` for codemode scripts.
- 17c4f48: Subagent children now use the parent session's model registry: providers registered at runtime (such as a Cloudflare AI Gateway provider) carry over with their auth and headers. A task with no model runs on the parent's current model. New `parent` option on `createSubagentRuntime`; llm-council members get the same registry.

  New `PI_SUBAGENTS_DIR` env var moves every file the subagent runtime writes (run records, patches, worktrees, session mirrors, workflow runs) under one root, and agent-urls reads run records from there. Unset, paths are unchanged.

## 0.5.2

### Patch Changes

- 561fad7: Declare `typebox` as a `"*"` peer dependency instead of a direct dependency so pi's host-provided copy is used (fixes the extension loader warning about duplicate runtime modules).

## 0.5.1

### Patch Changes

- 7c6a68d: Show cumulative token usage while subagents and council members are running, and expose live usage updates through the shared subagent runtime.

## 0.5.0

### Minor Changes

- 4fff6f8: Scope the default fleet command, shortcut, tool list, and footer indicator to active subagents owned by the current Pi session, with explicit `all` access to persisted machine-wide history. Propagate owner-session metadata through codemode and workflows without enabling session mirrors. Add a global statusline `hiddenStatuses` denylist for suppressing extension-provided footer segments.

## 0.4.0

### Minor Changes

- 9cd49ce: Content-addressed resume for the workflow engine.

  `runWorkflow` now computes a per-stage content key (Merkle-style sha256 over the
  stage's resolved prompt, model, tools, systemPrompt, outputSchema, needs,
  retries, maxTurns, maxToolCalls, timeoutMs, foreach shape, hasGate, sharesTree,
  worktree — plus the content keys of its upstream `needs` stages) and persists it
  in `stages/<id>.json` and a `stageKeys` map in `status.json`.

  `resumeFrom` no longer refuses when the spec changed. A previously-ok stage is
  reused ONLY if its content key still matches: an unchanged prefix replays free,
  a changed stage re-runs itself and (via upstream chaining) everything
  downstream. Old runDirs without `stageKeys` fall back to the whole-spec
  `specHash`. A `resume_summary` `onProgress` event reports replayed vs. re-run
  counts.

  Function-valued prompts now hash via `.toString()` (their source text) in both
  the per-stage key and `computeSpecHash`, closing the `'<function>'` gap that let
  prompt-closure edits go undetected.

## 0.3.0

### Minor Changes

- 00958ee: Deterministic cascading cancellation: a `session_shutdown` handler (quit/reload/new/resume/fork) now aborts every active child — foreground tasks were already aborted via the tool signal, but background runs (which deliberately carry no tool signal) only died with the process before. Aborted runs no longer capture a `.patch` and remove their worktree immediately, so an interrupt or parent exit can't leak a detached worktree; `sweepRunArtifacts` now also removes a ghost run's worktree when reaping it on next startup (closes the hard-exit/SIGKILL leak path). README documents the full worktree cleanup policy (when worktrees are removed, what happens to unclaimed `.patch` files).
- 00958ee: Persist subagent runs as standard pi sessions (additive dual-write). Every `dispatch` run now ALSO writes a standard pi session JSONL via the real `SessionManager` (from `@earendil-works/pi-coding-agent`) into the default sessions dir, with the session header's `parentSession` set to the owning pi session's file path — so runs show up in pi's native `/resume`, `/tree`, and `--fork` machinery. New `SpawnOptions.parentSession` opts into the mirror; the resulting path is recorded on `RunRecord.sessionFile` and shown by `fleet` `result`. The bespoke `.json` run store is unchanged (fleet/registry still read it). Opt-in keeps other shared-runtime consumers (codemode/workflow) unaffected. Compat caveats: no mirror when the owning session is in-memory (print mode), and no file when the child produced no assistant turn (SessionManager creates the JSONL lazily on the first assistant message).
- efef393: Add `patches` module (pure unified-diff parsing for the subagents /patches staging area, with correct hunkless-header and deleted-file handling), `parseAmpDispatch` for the `&` editor dispatch prefix, and `SearchableSelectList.filterValue` so overlays can gate action keys without eating type-to-filter keystrokes.

### Patch Changes

- 1f032e3: /fleet detail view now shows live activity for running agents: turn/tool-call counts in the meta line, a live transcript tail (last 10 events), and a 1s refresh so an open detail tracks the run instead of showing a frozen "(still running — no output yet)" stub.

## 0.2.0

### Minor Changes

- 121a19d: `createSubagentRuntime` gains `artifactsDir` (persist run records + bounded output to `<dir>/<namespace>/<runId>.json` for cross-extension fleet views), `spawn()` gains `maxTurns`/`maxToolCalls` budgets (abort on exceed), and the runtime gains `spawnDetached()` for fire-and-forget launches. New `readRunArtifacts(rootDir)` reads persisted records across namespaces.
- c60bd34: Add `subagents.ts`: an in-process subagent runtime (`createSubagentRuntime`) that spawns hermetic child agent sessions through pi's SDK (`createAgentSession`) — no subprocesses, no pi-subagents dependency. Tool allowlists by construction, closure-based supervisor channel (`<namespace>_contact_supervisor`), TypeBox `outputSchema` validation with a discriminated result union (`ok | crashed | empty | schema_invalid | aborted`), per-runtime concurrency cap, and an in-memory run registry. Also exports `resolveContainedAgentResource` for containment-checked resolution of bare names under the agent dir. `typebox` is now a runtime dependency.
- 0aabf31: New `workflow.ts`: a declarative workflow engine over the subagent runtime. Stages form a DAG via explicit `needs` (default linear chain), with `foreach` fan-out, `gate` validation loops with revise feedback, crash retries, per-workflow token budgets, and control artifacts under `<agentDir>/workflow-runs/` enabling `resumeFrom`. Two-channel handoff: typed outcomes flow via `StageContext.results`, and `sharesTree` stages hand dependents a bounded `git diff HEAD` — such stages never run concurrently with anything else (conservative resource exclusion). Ships with vitest coverage driven by a fake runtime (first test infra in the repo: root `pnpm test`).
- 0aabf31: `runWorkflow` accepts `signal` in its options and threads it into every stage spawn, so callers (e.g. codemode timeouts, tool aborts) can cancel a whole workflow.
- cacb4cc: Worktree isolation for builder agents. `spawn({ worktree: true })`, dispatch tasks with `worktree: true`, and workflow stages with `worktree: true` run in a detached git worktree (`~/.pi/agent/subagent-worktrees/<runId>`) — writes never touch the caller's tree, mutating tools stay parallel without `allowTreeMutation`, and the full change set (including untracked files, via `git add -A` + `git diff --cached HEAD`) is captured untruncated to `<runId>.patch` beside the run artifact. Merge-back stays central: inspect the patch, apply what you want. Also: bounded child transcripts (last 20 events) on run records, a process-wide child budget (8) under the per-runtime cap, and a `specHash` guard so `resumeFrom` fails loudly when stage definitions changed.
- 73c772e: Worktree isolation for builder agents. `spawn({ worktree: true })`, dispatch tasks with `worktree: true`, and workflow stages with `worktree: true` run in a detached git worktree (`~/.pi/agent/subagent-worktrees/<runId>`) — writes never touch the caller's tree, mutating tools stay parallel without `allowTreeMutation`, and the full change set (including untracked files, via `git add -A` + `git diff --cached HEAD`) is captured untruncated to `<runId>.patch` beside the run artifact. Merge-back stays central: inspect the patch, apply what you want. Also: bounded child transcripts (last 20 events) on run records, a process-wide child budget (8) under the per-runtime cap, and a `specHash` guard so `resumeFrom` fails loudly when stage definitions changed.

### Patch Changes

- cacb4cc: Fleet/runtime hardening: startup GC of run artifacts (7-day retention, removes patches + worktrees too) and reaping of ghost `running` records from dead host processes; `fleet` gains `action: 'cancel'` for live runs; `fleet result` shows worktree handoff and transcript; concurrent `dispatch` calls no longer cross-wire the live progress tree (keyed by toolCallId). Workflow `sharesTree` handoff now lists untracked files and marks 64KB truncation explicitly. Intercom: live-peer receipts poll up to ~3s before settling on `queued` (fixes watch-latency false queued). Repo: the smoke suite is now committed (`scripts/smoke-stack.sh`) with a CI job that runs it when ANTHROPIC_API_KEY is configured.

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
