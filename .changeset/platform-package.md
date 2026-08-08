---
'@nicknisi/pi-subagents': minor
---

New package: first-party subagent dispatch and fleet. `dispatch` fans out up to 8 hermetic in-process child agents in parallel (per-task prompts, models, tool allowlists, background flag); `fleet` (tool) and `/fleet` (command) inspect live and persisted runs across extensions using the shared runtime. No pi-subagents dependency.
