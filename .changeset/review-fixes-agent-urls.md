---
'@nicknisi/pi-agent-urls': patch
---

Fix `/agent read` completion (it no longer drops the `read` subcommand, filters by what you typed, and skips JSON parsing), keep the newest runs when more than 2500 records exist, resolve the agent dir with pi's `getAgentDir()`, and report runs left `running` by a dead host as `stale`. Also drops the redundant "result shown" notification and corrects the package description and README.
