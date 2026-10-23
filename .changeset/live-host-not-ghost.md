---
"@nicknisi/pi-shared": patch
---

Opening another pi session no longer kills the subagent and workflow runs of the sessions already open. The run sweep treated any running record whose host pid wasn't the current process as a dead host's ghost, removed its worktree and marked it aborted; it now does that only when the host process no longer exists.
