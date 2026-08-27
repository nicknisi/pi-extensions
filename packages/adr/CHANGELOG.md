# @nicknisi/pi-adr

## 0.2.0

### Minor Changes

- 3bb38e6: New package: `@nicknisi/pi-adr` injects the repo's `docs/decisions/` index into the system prompt as a steering veto list, so the agent sees which directions are already settled. Walks up from cwd, filenames only, superseded ADRs (in `superseded/`) excluded, no-ops when the directory doesn't exist.

### Patch Changes

- 44ee1bb: Only `0000-*` files are treated as templates now. Previously any ADR with "template" in its title (e.g. `0007-template-rendering.md`) was silently dropped from the injected veto list.
