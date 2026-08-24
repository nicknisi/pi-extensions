---
'@nicknisi/pi-codemode': minor
---

Add configurable child model defaults via `~/.pi/agent/configs/codemode.json` (`childModel`, `childThinkingLevel`), falling back to the session's current model and thinking level. Raise child spawn concurrency from 4 to 6 (workflow default too; process-wide ceiling stays 8). Stream live progress into the tool row while a codemode run executes: running/done/failed spawn counts plus recent log lines via `onUpdate` partials. Fix a duplicated line in the tool description.
