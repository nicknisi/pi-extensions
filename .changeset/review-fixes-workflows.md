---
'@nicknisi/pi-workflows': patch
---

Workflow scripts no longer run a second, unattended time when they start (which repeated side effects, skipped checkpoints, and could freeze pi on a retry loop); `meta` is now read from its initializer alone. Relaunched runs now work in the directory the original run used, and the tool description and README now say plainly that `checkpoint` is skipped without a UI and that Node modules come from `process.getBuiltinModule`.
