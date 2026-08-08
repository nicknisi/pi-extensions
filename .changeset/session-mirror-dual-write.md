---
'@nicknisi/pi-subagents': minor
'@nicknisi/pi-shared': minor
---

Persist subagent runs as standard pi sessions (additive dual-write). Every `dispatch` run now ALSO writes a standard pi session JSONL via the real `SessionManager` (from `@earendil-works/pi-coding-agent`) into the default sessions dir, with the session header's `parentSession` set to the owning pi session's file path — so runs show up in pi's native `/resume`, `/tree`, and `--fork` machinery. New `SpawnOptions.parentSession` opts into the mirror; the resulting path is recorded on `RunRecord.sessionFile` and shown by `fleet` `result`. The bespoke `.json` run store is unchanged (fleet/registry still read it). Opt-in keeps other shared-runtime consumers (codemode/workflow) unaffected. Compat caveats: no mirror when the owning session is in-memory (print mode), and no file when the child produced no assistant turn (SessionManager creates the JSONL lazily on the first assistant message).
