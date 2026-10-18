---
'@nicknisi/pi-workflows': minor
'@nicknisi/pi-shared': minor
---

Workflow agents that stop producing output for 5 minutes (tool time excluded) restart from the same prompt, up to 5 times. Agents with a `schema` are now told the JSON Schema, and an invalid answer is corrected in the same session before failing. The shared runtime gains `stallMs` and a `stalled` failure kind.
