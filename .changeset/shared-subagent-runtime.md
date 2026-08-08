---
'@nicknisi/pi-shared': minor
---

Add `subagents.ts`: an in-process subagent runtime (`createSubagentRuntime`) that spawns hermetic child agent sessions through pi's SDK (`createAgentSession`) — no subprocesses, no pi-subagents dependency. Tool allowlists by construction, closure-based supervisor channel (`<namespace>_contact_supervisor`), TypeBox `outputSchema` validation with a discriminated result union (`ok | crashed | empty | schema_invalid | aborted`), per-runtime concurrency cap, and an in-memory run registry. Also exports `resolveContainedAgentResource` for containment-checked resolution of bare names under the agent dir. `typebox` is now a runtime dependency.
