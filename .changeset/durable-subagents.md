---
'@nicknisi/pi-subagents': minor
'@nicknisi/pi-shared': minor
---

Subagents are durable. A dispatch run cut off by pi quitting, reloading, switching sessions, or crashing is marked interrupted instead of cancelled, and its worktree is kept. Reopening that session resumes it under the same run id, from its own transcript and in its worktree. Its answer lands in the transcript as a `Resumed subagent … completed` notice, and `/fleet all` shows interrupted runs as `interrupted`. Esc and `fleet` cancel still cancel for good.

shared: a child with a `parentSession` now writes its pi session file as it runs instead of mirroring it at the end, which removes the exported `writeSessionMirror`. Such runs store their spawn options on `RunRecord.resume`. Aborting with the new `HOST_EXIT` reason marks them `interrupted`, and the new `runtime.resumeDetached()` continues them. The startup sweep marks durable ghosts interrupted (keeping their worktree), sets `hostPid` while a run is still queued so queued ghosts are reaped too, and no longer reaps runs owned by another live pi process.
