---
'@nicknisi/pi-llm-council': minor
---

Spawn council members and the chairman through `@nicknisi/pi-shared`'s in-process subagent runtime instead of headless `pi` subprocesses. Behavior changes: children are hermetic — `extensions: null` / `skills: null` no longer inherit ambient resources (both mean "none"; named resources still load, containment-checked); member text is the child's final assistant message rather than a concatenation of all assistant messages (fixes wrong output when members use tools); spawning is refused inside pi-subagents child sessions (`PI_SUBAGENT_DEPTH`/`PI_SUBAGENT_CHILD`).
