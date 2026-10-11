---
'@nicknisi/pi-shared': minor
'@nicknisi/pi-subagents': patch
---

Remove `getModelProvider` (use `ctx.modelRegistry.complete()`/`streamSimple()` instead). Subagent runs that never produced an assistant turn are no longer mirrored as pi sessions (pi 1.0 started writing the session file on the first user message).
