---
'@nicknisi/pi-adr': patch
---

Only `0000-*` files are treated as templates now. Previously any ADR with "template" in its title (e.g. `0007-template-rendering.md`) was silently dropped from the injected veto list.
