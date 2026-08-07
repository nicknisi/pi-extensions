---
'@nicknisi/pi-agent-urls': patch
'@nicknisi/pi-answer': patch
'@nicknisi/pi-artifacts': patch
'@nicknisi/pi-btw': patch
'@nicknisi/pi-chat-input': patch
'@nicknisi/pi-claude-compat': patch
'@nicknisi/pi-cloak': patch
'@nicknisi/pi-handoff': patch
'@nicknisi/pi-header': patch
'@nicknisi/pi-llm-council': patch
'@nicknisi/pi-mg': patch
'@nicknisi/pi-recap': patch
'@nicknisi/pi-session-name': patch
'@nicknisi/pi-spinner': patch
---

Compile under `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Unchecked indexed reads are now narrowed or explicitly asserted where the index is in range by construction, and optional properties that can legitimately hold `undefined` declare it. Packages ship raw TypeScript, so this also affects how consumers typecheck against them; runtime behavior is unchanged.
