---
'@nicknisi/pi-subagents': minor
---

Add profiles (personas): named agent-definition markdown files that bundle a skill basket, tool allowlist, model, and system prompt. Dispatch tasks select one with the new strict `profile` field, and the `&` prefix resolves `&<name>` against profiles before falling back to a plain label. Profiles are discovered first-wins from `.pi/agents/` (project), `<agentDir>/agents/` (user), and embedder-provided `SubagentsOptions.profileDirs`; bare skill names resolve through the parent session's skill catalog, and unresolved skills warn without failing the dispatch.
