---
'@nicknisi/pi-session-name': patch
---

Auto-naming now uses a skill invocation's arguments (or the skill name) instead of the expanded skill body, terminal titles insert names literally (no `$&`/placeholder expansion), and `/sn clear` stays in effect after a reload or resume. `/sn` with a name that is only control characters now reports an error instead of silently clearing the name.
