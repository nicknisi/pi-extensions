---
'@nicknisi/pi-workflows': minor
---

New package: the model-facing front door to the first-party workflow engine. One `workflow` tool (actions: run / list / status / stop) compiles a JS workflow script in `node:vm` with injected globals — `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `cwd` — the exact contract the third-party `@quintinshaw/pi-dynamic-workflows` scripts use, so existing scripts run unchanged. Saved workflows are plain files in `~/.pi/agent/workflows/*.js` (global) and `.pi/workflows/*.js` (project, trusted only) — the registry is `ls`. Runs spawn through `@nicknisi/pi-shared`'s subagent runtime (namespace `workflows`), so children appear in the `fleet` radar; `status`/`stop` read from / cancel via the same runtime's run records. A `/wf` command is the thin human wrapper. Replaces the third-party engine.
