---
'@nicknisi/pi-shared': minor
---

Content-addressed resume for the workflow engine.

`runWorkflow` now computes a per-stage content key (Merkle-style sha256 over the
stage's resolved prompt, model, tools, systemPrompt, outputSchema, needs,
retries, maxTurns, maxToolCalls, timeoutMs, foreach shape, hasGate, sharesTree,
worktree — plus the content keys of its upstream `needs` stages) and persists it
in `stages/<id>.json` and a `stageKeys` map in `status.json`.

`resumeFrom` no longer refuses when the spec changed. A previously-ok stage is
reused ONLY if its content key still matches: an unchanged prefix replays free,
a changed stage re-runs itself and (via upstream chaining) everything
downstream. Old runDirs without `stageKeys` fall back to the whole-spec
`specHash`. A `resume_summary` `onProgress` event reports replayed vs. re-run
counts.

Function-valued prompts now hash via `.toString()` (their source text) in both
the per-stage key and `computeSpecHash`, closing the `'<function>'` gap that let
prompt-closure edits go undetected.
