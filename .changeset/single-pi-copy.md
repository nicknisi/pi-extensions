---
'@nicknisi/pi-shared': minor
'@nicknisi/pi-subagents': patch
'@nicknisi/pi-workflows': patch
'@nicknisi/pi-llm-council': patch
---

Stop loading a second copy of pi at startup. pi loads pi-shared with a native import that can't see pi's module aliases, so pi-shared's own pi imports pulled a separate pi from disk (about 0.4s and 100MB per session, with its own keybindings and version). pi-shared no longer imports pi at runtime: subagents, workflows and llm-council hand it the running pi through the new `bindPiSdk()`, and unbound callers import pi lazily on first use.

Breaking for direct pi-shared users: `SearchableSelectList` moved into pi-subagents, the unused `columns()` helper is gone, and `resolveContainedAgentResource()` now takes the agent dir as its first argument.
