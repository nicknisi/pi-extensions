---
'@nicknisi/pi-subagents': patch
---

`/patches` skips already-decided patches before pre-flighting and runs the remaining `git apply --check` pre-flights in parallel; the dispatch profile catalog is rebuilt from the session's cwd on session start. The fleet overlay filter matches agent, model, and prompt text and its refresh timer stops when the overlay is disposed; the statusline and overlay no longer re-parse every run artifact on each tick; and `/again` only re-fires dispatches from the current branch.
