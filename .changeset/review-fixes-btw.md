---
'@nicknisi/pi-btw': patch
---

/btw now snapshots the same context the main agent sees (branch summaries, custom messages, context edits, newest compaction only), drops stale deltas after cancel, aborts in-flight requests when the window is disposed, refuses to run outside the TUI, forks in-memory sessions into the temp dir instead of the project, and shell-quotes the fork session path. Requires pi >=0.87.0.
