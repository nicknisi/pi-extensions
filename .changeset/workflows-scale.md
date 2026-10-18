---
'@nicknisi/pi-workflows': minor
'@nicknisi/pi-shared': minor
---

Workflows run up to 16 agents at once by default (fewer on small machines; `PI_WORKFLOW_MAX_CONCURRENT` sets 1–256). A failed `agent()` inside `parallel()`/`pipeline()` now becomes `null` instead of failing the whole wave, and runs are capped at 1,000 agents and 4,096 items per call.
