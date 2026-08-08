---
'@nicknisi/pi-subagents': patch
'@nicknisi/pi-shared': patch
---

/fleet detail view now shows live activity for running agents: turn/tool-call counts in the meta line, a live transcript tail (last 10 events), and a 1s refresh so an open detail tracks the run instead of showing a frozen "(still running — no output yet)" stub.
