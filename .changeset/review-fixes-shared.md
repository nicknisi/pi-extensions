---
'@nicknisi/pi-shared': patch
---

Subagent `spawn()` no longer rejects on setup errors, early failures are persisted as `failed`, and a failed model runtime is retried; `runWorkflow` settles needs cycles and throwing prompt functions instead of rejecting or double-settling, and `parseUnifiedDiff` now reports paths for binary, renamed and mode-only files. Also ships the missing source files, drops the unused `pi-tui` peer, and corrects the README.
