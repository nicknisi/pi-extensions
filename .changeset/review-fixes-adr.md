---
'@nicknisi/pi-adr': patch
---

The ADR hook no longer throws on every prompt when `docs/decisions` is a file or cannot be read. In that case it now skips injecting the section.
