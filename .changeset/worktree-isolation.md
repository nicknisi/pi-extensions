---
'@nicknisi/pi-shared': minor
'@nicknisi/pi-subagents': minor
---

Worktree isolation for builder agents. `spawn({ worktree: true })`, dispatch tasks with `worktree: true`, and workflow stages with `worktree: true` run in a detached git worktree (`~/.pi/agent/subagent-worktrees/<runId>`) — writes never touch the caller's tree, mutating tools stay parallel without `allowTreeMutation`, and the full change set (including untracked files, via `git add -A` + `git diff --cached HEAD`) is captured untruncated to `<runId>.patch` beside the run artifact. Merge-back stays central: inspect the patch, apply what you want. Also: bounded child transcripts (last 20 events) on run records, a process-wide child budget (8) under the per-runtime cap, and a `specHash` guard so `resumeFrom` fails loudly when stage definitions changed.
