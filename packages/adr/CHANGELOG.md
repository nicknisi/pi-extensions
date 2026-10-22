# @nicknisi/pi-adr

## 0.3.1

### Patch Changes

- c33f39e: handoff: put the generated prompt into the new session's editor through the `withSession` context. The old context is stale after the session switch, so the prompt never arrived. adr: list ADR paths relative to cwd so they resolve when pi runs in a subdirectory, and stop searching at the repo root.

## 0.3.0

### Minor Changes

- b67617e: Move to public pi APIs. orchestrate: the goal evaluator is a single `ctx.modelRegistry.streamSimple()` call instead of a sub-session built on a private runtime, and self-paced loops tick from `agent_settled` instead of a 1.5s timer (needs pi >=0.87). compact-tools: uses `pi.registerToolRenderer()` instead of patching `ToolExecutionComponent` (needs pi >=1.0.1; collapsed rows no longer hide inline images). adr: writes a `decision_records` system prompt section instead of replacing the whole prompt each run, keeping prompt caching intact (needs pi >=0.86).

## 0.2.0

### Minor Changes

- 3bb38e6: New package: `@nicknisi/pi-adr` injects the repo's `docs/decisions/` index into the system prompt as a steering veto list, so the agent sees which directions are already settled. Walks up from cwd, filenames only, superseded ADRs (in `superseded/`) excluded, no-ops when the directory doesn't exist.

### Patch Changes

- 44ee1bb: Only `0000-*` files are treated as templates now. Previously any ADR with "template" in its title (e.g. `0007-template-rendering.md`) was silently dropped from the injected veto list.
