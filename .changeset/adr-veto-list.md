---
'@nicknisi/pi-adr': minor
---

New package: `@nicknisi/pi-adr` injects the repo's `docs/decisions/` index into the system prompt as a steering veto list, so the agent sees which directions are already settled. Walks up from cwd, filenames only, superseded ADRs (in `superseded/`) excluded, no-ops when the directory doesn't exist.
