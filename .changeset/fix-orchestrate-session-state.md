---
'@nicknisi/pi-orchestrate': patch
---

Each session now keeps its `/goal` and `/loop` state in its own file (`.pi-goal/<session>.json`), so another session in the same folder can no longer overwrite or delete it. A self-paced `/loop` no longer runs a duplicate iteration after auto-compaction. An existing `.pi-goal/state.json` from an older version is ignored.
