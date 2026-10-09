---
'@nicknisi/pi-subagents': minor
'@nicknisi/pi-shared': minor
'@nicknisi/pi-workflows': minor
'@nicknisi/pi-codemode': minor
---

Subagent children now use the parent session's model registry: providers registered at runtime (such as a Cloudflare AI Gateway provider) carry over with their auth and headers. A task with no model runs on the parent's current model. New `parent` option on `createSubagentRuntime`.

New `PI_SUBAGENTS_DIR` env var moves every file the subagent runtime writes (run records, patches, worktrees, session mirrors, workflow runs) under one root. Unset, paths are unchanged.
