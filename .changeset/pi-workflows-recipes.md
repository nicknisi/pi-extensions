---
'@nicknisi/pi-workflows': minor
---

Examples + patterns layer: three standalone workflow scripts in `examples/` (copy-and-adapt — the registry is `ls`, no index re-exports them) plus a README Recipes section. `lanes.js` ports the parallel file-disjoint editing pattern under a hard-rules preamble. `gates.js` distills three judge/verify prompt builders from `@quintinshaw/pi-dynamic-workflows` (adversarial refutation, deep-research coverage, 3-way code-review verdict) as plain documented functions. `bake-off.js` races N models on one task in isolated worktrees and an advisory judge picks the winner. To support bake-off, `agent()` gained a `worktree: true` opt (forwarded to the subagent runtime's isolated-worktree spawn; the `.patch` path is surfaced via an opt-in `{ value, patchPath, runId }` return — non-worktree calls are unchanged) and `engine.ts` exports a `compileScript` for spawn-free compile + `meta` reads, used by the new `examples.test.ts` smoke test.
