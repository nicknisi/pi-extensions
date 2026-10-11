---
'@nicknisi/pi-orchestrate': minor
'@nicknisi/pi-compact-tools': minor
'@nicknisi/pi-adr': minor
---

Move to public pi APIs. orchestrate: the goal evaluator is a single `ctx.modelRegistry.streamSimple()` call instead of a sub-session built on a private runtime, and self-paced loops tick from `agent_settled` instead of a 1.5s timer (needs pi >=0.87). compact-tools: uses `pi.registerToolRenderer()` instead of patching `ToolExecutionComponent` (needs pi >=1.0.1; collapsed rows no longer hide inline images). adr: writes a `decision_records` system prompt section instead of replacing the whole prompt each run, keeping prompt caching intact (needs pi >=0.86).
