---
'@nicknisi/pi-codemode': minor
---

codemode now writes a runscope orchestration ledger into the parent session. Every `spawn` and `runWorkflow` lifecycle event — `spawn_start`, `spawn_end`, `stage_start`, `stage_end`, `gate_result` — is appended as a typed custom entry (`customType: 'codemode-runscope'`) via `pi.appendEntry`, each carrying `{ runId, spanId, parentSpanId, kind, ts }`. Custom entries persist to the session JSONL without entering LLM context. Stage `parentSpanId` is derived from `needs` edges so the trace tree mirrors the workflow DAG; spawns inside a workflow are parented to their stage via `AsyncLocalStorage`. Dependency-free — no OpenTelemetry.
