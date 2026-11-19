---
'@nicknisi/pi-orchestrate': patch
---

`/goal` no longer pauses on errors that pi recovers from by auto-retry or compaction. Pressing Escape during goal evaluation now cancels it and pauses the goal, and clearing a paused goal no longer aborts an unrelated turn. A self-paced `/loop` resumes after a goal is achieved. Timer `/loop` intervals must be at least 1 second.
