---
'@nicknisi/pi-subagents': minor
'@nicknisi/pi-shared': patch
---

subagents: a finished background child now wakes the parent with its answer (starting a turn when idle, or steered in at the next tool boundary), so the model no longer polls `fleet`. `dispatch` tasks take a `thinking` level for one child, with or without `model`. pi-shared exports `THINKING_LEVELS` and `ThinkingLevel`.
