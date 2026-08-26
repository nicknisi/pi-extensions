---
'@nicknisi/pi-workflows': minor
---

Human-steerable runs: session-scoped `pause`/`resume` (tool actions and `/wf pause|resume`) hold a run before its next `agent()` spawn; new script globals `checkpoint(label?)` (confirm-gated pause; reject stops the run) and `ask(question, options?)` (select/confirm mid-run); the footer status now tracks `phase()` markers. Adds three examples ported from osolmaz/pi-workflows: `autoplan.js`, `sanity-check.js`, `autoimplement.js`.
