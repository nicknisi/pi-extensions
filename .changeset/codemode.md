---
'@nicknisi/pi-codemode': minor
---

New package: codemode rebuilt on the first-party subagent platform. The `codemode` tool executes model-written TypeScript in-process (via bundle-require) with an injected `spawn` binding over the shared in-process runtime — compositional orchestration (Promise.all fan-out, pipelines, map/reduce) with typed SpawnResults, bounded results/logs, timeout with child abort, and no pi-subagents dependency.
