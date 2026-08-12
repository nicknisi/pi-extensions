---
'@nicknisi/pi-shared': minor
'@nicknisi/pi-subagents': minor
'@nicknisi/pi-statusline': minor
'@nicknisi/pi-codemode': patch
'@nicknisi/pi-workflows': patch
---

Scope the default fleet command, shortcut, tool list, and footer indicator to active subagents owned by the current Pi session, with explicit `all` access to persisted machine-wide history. Propagate owner-session metadata through codemode and workflows without enabling session mirrors. Add a global statusline `hiddenStatuses` denylist for suppressing extension-provided footer segments.
