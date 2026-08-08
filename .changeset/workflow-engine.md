---
'@nicknisi/pi-shared': minor
---

New `workflow.ts`: a declarative workflow engine over the subagent runtime. Stages form a DAG via explicit `needs` (default linear chain), with `foreach` fan-out, `gate` validation loops with revise feedback, crash retries, per-workflow token budgets, and control artifacts under `<agentDir>/workflow-runs/` enabling `resumeFrom`. Two-channel handoff: typed outcomes flow via `StageContext.results`, and `sharesTree` stages hand dependents a bounded `git diff HEAD` — such stages never run concurrently with anything else (conservative resource exclusion). Ships with vitest coverage driven by a fake runtime (first test infra in the repo: root `pnpm test`).
