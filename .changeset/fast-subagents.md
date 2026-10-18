---
'@nicknisi/pi-fast': minor
'@nicknisi/pi-shared': minor
---

Fast mode now reaches subagent and workflow children: they follow the session's `/fast` toggle and share its rate-limit cooldown. The shared runtime gains `childExtensions()`, a registry of inline extensions loaded into every child.
