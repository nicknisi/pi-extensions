---
'@nicknisi/pi-session-name': minor
---

Auto-rename: when a decision model such as TypeSafe's Jev is available, every few user prompts (`renameEvery`, default 3) session-name checks whether the work has moved to a different task and renames the session when it has. Only names the extension set itself are renamed; names from `/sn`, `/name` or `--name` are never touched. Turn it off with `autoRename: false`.
