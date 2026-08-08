# @nicknisi/pi-subagents

## 0.1.0

### Minor Changes

- 9006737: New package: first-party subagent dispatch and fleet. `dispatch` fans out up to 8 hermetic in-process child agents in parallel (per-task prompts, models, tool allowlists, background flag); `fleet` (tool) and `/fleet` (command) inspect live and persisted runs across extensions using the shared runtime. No pi-subagents dependency.
- 29eaae8: TUI surfaces for the platform: dispatch gets live per-task progress (renderCall/renderResult with council-style status trees) plus a background-runs widget; `/fleet` is now an interactive overlay with drill-down run details (text fallback when headless); intercom deliveries render as styled peer-mail cards with an aligned `/intercom` listing; codemode gets renderCall/renderResult with collapsed output, log tree, and error states.
- cacb4cc: Worktree isolation for builder agents. `spawn({ worktree: true })`, dispatch tasks with `worktree: true`, and workflow stages with `worktree: true` run in a detached git worktree (`~/.pi/agent/subagent-worktrees/<runId>`) — writes never touch the caller's tree, mutating tools stay parallel without `allowTreeMutation`, and the full change set (including untracked files, via `git add -A` + `git diff --cached HEAD`) is captured untruncated to `<runId>.patch` beside the run artifact. Merge-back stays central: inspect the patch, apply what you want. Also: bounded child transcripts (last 20 events) on run records, a process-wide child budget (8) under the per-runtime cap, and a `specHash` guard so `resumeFrom` fails loudly when stage definitions changed.
- 73c772e: Worktree isolation for builder agents. `spawn({ worktree: true })`, dispatch tasks with `worktree: true`, and workflow stages with `worktree: true` run in a detached git worktree (`~/.pi/agent/subagent-worktrees/<runId>`) — writes never touch the caller's tree, mutating tools stay parallel without `allowTreeMutation`, and the full change set (including untracked files, via `git add -A` + `git diff --cached HEAD`) is captured untruncated to `<runId>.patch` beside the run artifact. Merge-back stays central: inspect the patch, apply what you want. Also: bounded child transcripts (last 20 events) on run records, a process-wide child budget (8) under the per-runtime cap, and a `specHash` guard so `resumeFrom` fails loudly when stage definitions changed.

### Patch Changes

- cacb4cc: Fleet/runtime hardening: startup GC of run artifacts (7-day retention, removes patches + worktrees too) and reaping of ghost `running` records from dead host processes; `fleet` gains `action: 'cancel'` for live runs; `fleet result` shows worktree handoff and transcript; concurrent `dispatch` calls no longer cross-wire the live progress tree (keyed by toolCallId). Workflow `sharesTree` handoff now lists untracked files and marks 64KB truncation explicitly. Intercom: live-peer receipts poll up to ~3s before settling on `queued` (fixes watch-latency false queued). Repo: the smoke suite is now committed (`scripts/smoke-stack.sh`) with a CI job that runs it when ANTHROPIC_API_KEY is configured.
- Updated dependencies [cacb4cc]
- Updated dependencies [121a19d]
- Updated dependencies [c60bd34]
- Updated dependencies [0aabf31]
- Updated dependencies [0aabf31]
- Updated dependencies [cacb4cc]
- Updated dependencies [73c772e]
  - @nicknisi/pi-shared@0.2.0
