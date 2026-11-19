---
'@nicknisi/pi-turn-timer': patch
---

The timer now covers the whole run even when pi retries, compacts, or continues with queued messages (previously only the last sub-run was timed), and a ctx.ui prompt still open when the run settles is no longer counted. The published package no longer ships compiled test files.
