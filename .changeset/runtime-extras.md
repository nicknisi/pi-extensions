---
'@nicknisi/pi-shared': minor
---

`createSubagentRuntime` gains `artifactsDir` (persist run records + bounded output to `<dir>/<namespace>/<runId>.json` for cross-extension fleet views), `spawn()` gains `maxTurns`/`maxToolCalls` budgets (abort on exceed), and the runtime gains `spawnDetached()` for fire-and-forget launches. New `readRunArtifacts(rootDir)` reads persisted records across namespaces.
