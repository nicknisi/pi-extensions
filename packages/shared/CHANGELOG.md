# @nicknisi/pi-shared

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
