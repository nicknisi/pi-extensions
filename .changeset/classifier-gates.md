---
'@nicknisi/pi-shared': minor
'@nicknisi/pi-heads-up': minor
'@nicknisi/pi-answer': minor
---

Optional classifier models. heads-up scores each automatic check with a classifier (TypeSafe's Jev by default) in shadow mode, logging the score with each event; `gateEnforce: true` skips checks below `gateThreshold`. answer shows a `? ctrl+. to answer` footer hint after replies a classifier judges to ask you questions. Both behave as before when no classifier is available. pi-shared adds `findClassifier`, `classifyBool`, and `DEFAULT_CLASSIFIERS`.

heads-up also logs every check, with its side-request cost, and `/heads-up` shows the logged total, since these requests never reach the session cost. The event log keeps 2000 events instead of 500. answer defaults to `claude-haiku-4-5` then `claude-sonnet-5` for extraction instead of Fable 5 and Opus 5, and `/answer` no longer requires a session model.
