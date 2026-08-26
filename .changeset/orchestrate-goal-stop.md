---
'@nicknisi/pi-orchestrate': patch
---

`/goal stop` (and clear aliases) now stops a running `/loop` too — previously it replied "No goal set" while a loop kept re-firing, which read as a goal that couldn't be stopped. Clearing also aborts the in-flight turn so the stop is immediate.
