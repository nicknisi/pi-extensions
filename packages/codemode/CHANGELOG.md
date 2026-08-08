# @nicknisi/pi-codemode

## 0.1.0

### Minor Changes

- aa583e4: The `codemode` tool gains a third injected binding: `runWorkflow(spec, opts?)` — the shared declarative workflow engine (needs/foreach/gates/retries, sharesTree tree-diff handoff, control artifacts + resume), bound to the codemode runtime with the tool's abort signals threaded into every stage spawn.
- aa583e4: New package: codemode rebuilt on the first-party subagent platform. The `codemode` tool executes model-written TypeScript in-process (via bundle-require) with an injected `spawn` binding over the shared in-process runtime — compositional orchestration (Promise.all fan-out, pipelines, map/reduce) with typed SpawnResults, bounded results/logs, timeout with child abort, and no pi-subagents dependency.
- 29eaae8: TUI surfaces for the platform: dispatch gets live per-task progress (renderCall/renderResult with council-style status trees) plus a background-runs widget; `/fleet` is now an interactive overlay with drill-down run details (text fallback when headless); intercom deliveries render as styled peer-mail cards with an aligned `/intercom` listing; codemode gets renderCall/renderResult with collapsed output, log tree, and error states.

### Patch Changes

- Updated dependencies [cacb4cc]
- Updated dependencies [121a19d]
- Updated dependencies [c60bd34]
- Updated dependencies [0aabf31]
- Updated dependencies [0aabf31]
- Updated dependencies [cacb4cc]
- Updated dependencies [73c772e]
  - @nicknisi/pi-shared@0.2.0
