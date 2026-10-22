---
'@nicknisi/pi-shared': minor
'@nicknisi/pi-heads-up': minor
'@nicknisi/pi-answer': minor
---

Optional classifier models. heads-up scores each automatic check with a classifier (TypeSafe's Jev by default) in shadow mode, logging the score with each event; `gateEnforce: true` skips checks below `gateThreshold`. answer shows a `? ctrl+. to answer` footer hint after replies a classifier judges to ask you questions. Both behave as before when no classifier is available. pi-shared adds `findClassifier`, `classifyBool`, and `DEFAULT_CLASSIFIERS`.
