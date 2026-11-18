---
'@nicknisi/pi-stash': minor
---

Save stashed drafts per working directory, so they survive `/reload`, restarts and new sessions instead of living only in memory. Each draft is its own file, written atomically and flushed to disk; restoring claims a draft by deleting its file, so two windows never restore the same one and no lock is needed. The stack keeps the newest 10 drafts, unreadable draft files are left alone, and the widget preview drops control characters. Sending a message only auto-restores drafts from the current session; `ctrl+s` restores drafts from any window in the directory.
