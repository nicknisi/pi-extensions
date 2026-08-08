---
'@nicknisi/pi-agent-urls': patch
---

Repoint agent-urls at the first-party runtime's persisted run records (`~/.pi/agent/subagent-runs/<namespace>/<runId>.json`) instead of nicobailon/pi-subagents' state dirs (session JSONLs, tmpdir async/chain dirs, artifact dirs — all gone). URIs are now `agent://<namespace>/<runId>[/output|error|raw]`; `history://` transcript reading is dropped because records carry bounded output, not session files.
