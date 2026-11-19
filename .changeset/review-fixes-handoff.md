---
'@nicknisi/pi-handoff': patch
---

`/handoff` now works in RPC mode instead of crashing, includes compaction/branch summaries and custom messages in its input, truncates an oversized newest message instead of sending no conversation, and walks parent sessions with node:fs (cycle-safe, depth-capped, works on Windows). README and package description now match the actual behavior.
