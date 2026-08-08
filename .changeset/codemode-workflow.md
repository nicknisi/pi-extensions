---
'@nicknisi/pi-codemode': minor
---

The `codemode` tool gains a third injected binding: `runWorkflow(spec, opts?)` — the shared declarative workflow engine (needs/foreach/gates/retries, sharesTree tree-diff handoff, control artifacts + resume), bound to the codemode runtime with the tool's abort signals threaded into every stage spawn.
