---
'@nicknisi/pi-ask-user-question': minor
---

New package: a fork of `@juicesharp/rpiv-ask-user-question` with an AFK timeout. If a questionnaire goes untouched for 5 minutes, the dialog closes and the agent is told the user is away: continue already-authorized work, but treat nothing as approval or as an answer to a scope or safety question. The first key the dialog receives stops the timer. Config moves to `~/.pi/agent/configs/ask-user-question.json`.
