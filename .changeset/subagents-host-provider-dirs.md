---
'@nicknisi/pi-subagents': minor
'@nicknisi/pi-shared': minor
'@nicknisi/pi-workflows': minor
'@nicknisi/pi-llm-council': minor
'@nicknisi/pi-agent-urls': minor
---

Subagent children now use the parent session's model registry: providers registered at runtime (such as a Cloudflare AI Gateway provider) carry over with their auth and headers. A task with no model runs on the parent's current model. New `parent` option on `createSubagentRuntime`; llm-council members get the same registry.

New `PI_SUBAGENTS_DIR` env var moves every file the subagent runtime writes (run records, patches, worktrees, session mirrors, workflow runs) under one root, and agent-urls reads run records from there. Unset, paths are unchanged.
