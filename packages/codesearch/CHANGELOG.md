# @nicknisi/pi-codesearch

## 0.3.3

### Patch Changes

- Updated dependencies [245ee0f]
  - @nicknisi/pi-shared@0.8.1

## 0.3.2

### Patch Changes

- Updated dependencies [7801bfc]
  - @nicknisi/pi-shared@0.8.0

## 0.3.1

### Patch Changes

- Updated dependencies [c22cede]
- Updated dependencies [01de359]
- Updated dependencies [79ab2c6]
- Updated dependencies [db67986]
  - @nicknisi/pi-shared@0.7.0

## 0.3.0

### Minor Changes

- b67617e: Adopt pi 1.x tool metadata. Rarely used tools (`list_agent_runs`, `read_agent_url`, `ast_search`, `ast_rewrite`, `codesearch`, `codefetch`, `llm_council`, `fleet`, `workflow`) register as `deferred`, so they stay out of the system prompt when the built-in `tool_search` is on; without it they are declared directly as before (new `declareUnlessSearchable` helper in pi-shared). Every tool in these packages gains `annotations` for permission extensions (worst-case hints for `dispatch` and `workflow`), and `list_agent_runs` returns `structuredContent` for codemode scripts.

### Patch Changes

- Updated dependencies [b67617e]
- Updated dependencies [b67617e]
- Updated dependencies [b67617e]
- Updated dependencies [17c4f48]
  - @nicknisi/pi-shared@0.6.0

## 0.2.1

### Patch Changes

- 561fad7: Declare `typebox` as a `"*"` peer dependency instead of a direct dependency so pi's host-provided copy is used (fixes the extension loader warning about duplicate runtime modules).

## 0.2.0

### Minor Changes

- fa67d94: Add public GitHub code search through grep.app and file fetching by ref and line range, with bounded output and cancellation. Retain upstream attribution without depending on dot-pi.
