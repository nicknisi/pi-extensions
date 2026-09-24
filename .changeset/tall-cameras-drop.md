---
'@nicknisi/pi-orchestrate': patch
---

Make /goal completion evidence-aware using the current model, without an additional AI service. Validate cited session evidence, distinguish unverified results from unfinished work, and pause on evaluator failures or bounded continuation limits. Add /goal resume, persist paused state, and cancel stale evaluations when goals or sessions change.
