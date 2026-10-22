---
'@nicknisi/pi-shared': patch
---

Subagent worktree runs no longer lose work. Timeouts, stalls and turn or tool-call budget limits now capture the patch. Only a caller cancel or host shutdown removes the worktree right away. Setup failures (unknown model, a throw while creating the session) remove the worktree and mark the run failed instead of leaking it as `running`. Patches are written by git directly with `--binary`, so diffs over 1 MB and binary edits are captured and apply cleanly.
