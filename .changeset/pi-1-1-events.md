---
'@nicknisi/pi-turn-timer': minor
'@nicknisi/pi-session-name': patch
'@nicknisi/pi-statusline': minor
---

Use pi's newer lifecycle events. turn-timer leaves out time spent waiting on `ctx.ui` prompts and labels cancelled runs. session-name skips auto-naming after a cancelled run. statusline writes `permit`/`question` tmux status while a `ctx.ui` prompt is open.
