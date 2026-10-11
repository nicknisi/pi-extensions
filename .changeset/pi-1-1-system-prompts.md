---
'@nicknisi/pi-answer': patch
'@nicknisi/pi-btw': patch
'@nicknisi/pi-handoff': patch
'@nicknisi/pi-session-name': patch
---

Fix system prompts being silently dropped on pi >=0.86: model calls now go through `ctx.modelRegistry.complete()`/`streamSimple()`, which accept `systemPrompt` and resolve auth. Requires pi >=0.86.0.
