# @nicknisi/pi-shared

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
