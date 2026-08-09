# @nicknisi/pi-workflows

## 0.2.0

### Minor Changes

- 24e0892: Examples + patterns layer: three standalone workflow scripts in `examples/` (copy-and-adapt — the registry is `ls`, no index re-exports them) plus a README Recipes section. `lanes.js` ports the parallel file-disjoint editing pattern under a hard-rules preamble. `gates.js` distills three judge/verify prompt builders from `@quintinshaw/pi-dynamic-workflows` (adversarial refutation, deep-research coverage, 3-way code-review verdict) as plain documented functions. `bake-off.js` races N models on one task in isolated worktrees and an advisory judge picks the winner. To support bake-off, `agent()` gained a `worktree: true` opt (forwarded to the subagent runtime's isolated-worktree spawn; the `.patch` path is surfaced via an opt-in `{ value, patchPath, runId }` return — non-worktree calls are unchanged) and `engine.ts` exports a `compileScript` for spawn-free compile + `meta` reads, used by the new `examples.test.ts` smoke test.
- efdd33f: New package: the model-facing front door to the first-party workflow engine. One `workflow` tool (actions: run / list / status / stop) compiles a JS workflow script in `node:vm` with injected globals — `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `cwd` — the exact contract the third-party `@quintinshaw/pi-dynamic-workflows` scripts use, so existing scripts run unchanged. Saved workflows are plain files in `~/.pi/agent/workflows/*.js` (global) and `.pi/workflows/*.js` (project, trusted only) — the registry is `ls`. Runs spawn through `@nicknisi/pi-shared`'s subagent runtime (namespace `workflows`), so children appear in the `fleet` radar; `status`/`stop` read from / cancel via the same runtime's run records. A `/wf` command is the thin human wrapper. Replaces the third-party engine.

### Patch Changes

- Updated dependencies [9cd49ce]
  - @nicknisi/pi-shared@0.4.0
