# @nicknisi/pi-compact-tools

## 0.2.3

### Patch Changes

- Updated dependencies [245ee0f]
  - @nicknisi/pi-shared@0.8.1

## 0.2.2

### Patch Changes

- Updated dependencies [7801bfc]
  - @nicknisi/pi-shared@0.8.0

## 0.2.1

### Patch Changes

- Updated dependencies [c22cede]
- Updated dependencies [01de359]
- Updated dependencies [79ab2c6]
- Updated dependencies [db67986]
  - @nicknisi/pi-shared@0.7.0

## 0.2.0

### Minor Changes

- b67617e: Move to public pi APIs. orchestrate: the goal evaluator is a single `ctx.modelRegistry.streamSimple()` call instead of a sub-session built on a private runtime, and self-paced loops tick from `agent_settled` instead of a 1.5s timer (needs pi >=0.87). compact-tools: uses `pi.registerToolRenderer()` instead of patching `ToolExecutionComponent` (needs pi >=1.0.1; collapsed rows no longer hide inline images). adr: writes a `decision_records` system prompt section instead of replacing the whole prompt each run, keeping prompt caching intact (needs pi >=0.86).

### Patch Changes

- Updated dependencies [b67617e]
- Updated dependencies [b67617e]
- Updated dependencies [b67617e]
- Updated dependencies [17c4f48]
  - @nicknisi/pi-shared@0.6.0

## 0.1.1

### Patch Changes

- Updated dependencies [561fad7]
  - @nicknisi/pi-shared@0.5.2

## 0.1.0

### Minor Changes

- ea1e6c3: Add compact tool displays with human-readable headers, one preview line, and native success/error backgrounds for all tools. Preserve original expanded rendering through Ctrl+O and fullscreen clicks without changing tool results or model context.
