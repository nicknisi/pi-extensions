---
'@nicknisi/pi-subagents': minor
'@nicknisi/pi-shared': minor
---

Deterministic cascading cancellation: a `session_shutdown` handler (quit/reload/new/resume/fork) now aborts every active child — foreground tasks were already aborted via the tool signal, but background runs (which deliberately carry no tool signal) only died with the process before. Aborted runs no longer capture a `.patch` and remove their worktree immediately, so an interrupt or parent exit can't leak a detached worktree; `sweepRunArtifacts` now also removes a ghost run's worktree when reaping it on next startup (closes the hard-exit/SIGKILL leak path). README documents the full worktree cleanup policy (when worktrees are removed, what happens to unclaimed `.patch` files).
