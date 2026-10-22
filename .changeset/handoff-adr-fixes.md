---
'@nicknisi/pi-handoff': patch
'@nicknisi/pi-adr': patch
---

handoff: put the generated prompt into the new session's editor through the `withSession` context. The old context is stale after the session switch, so the prompt never arrived. adr: list ADR paths relative to cwd so they resolve when pi runs in a subdirectory, and stop searching at the repo root.
