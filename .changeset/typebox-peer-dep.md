---
'@nicknisi/pi-artifacts': patch
'@nicknisi/pi-ast-grep': patch
'@nicknisi/pi-checkpoint': patch
'@nicknisi/pi-codemode': patch
'@nicknisi/pi-codesearch': patch
'@nicknisi/pi-llm-council': patch
'@nicknisi/pi-relay': patch
'@nicknisi/pi-shared': patch
'@nicknisi/pi-subagents': patch
'@nicknisi/pi-workflows': patch
---

Declare `typebox` as a `"*"` peer dependency instead of a direct dependency so pi's host-provided copy is used (fixes the extension loader warning about duplicate runtime modules).
