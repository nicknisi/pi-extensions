---
'@nicknisi/pi-stash': minor
---

Save stashed drafts per working directory, so they survive `/reload`, restarts and new sessions instead of living only in memory. Writes are atomic, the stack keeps the newest 10 drafts, an unreadable stash file is never overwritten, and the widget preview drops control characters. Sending a message only auto-restores drafts from the current session; `ctrl+s` restores drafts from any window in the directory.
