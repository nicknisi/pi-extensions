# @nicknisi/pi-ask-user-question

## 0.1.1

### Patch Changes

- 6bfdb8e: Aborting an `ask_user_question` call in an RPC host now closes the host's open dialog and cancels the questionnaire instead of waiting for an answer. The questionnaire UI is now pre-warmed only in interactive terminal sessions, and the README's reference docs ship with the package.

## 0.1.0

### Minor Changes

- d54a07c: New package: a fork of `@juicesharp/rpiv-ask-user-question` with an AFK timeout. If a questionnaire goes untouched for 5 minutes, the dialog closes and the agent is told the user is away: continue already-authorized work, but treat nothing as approval or as an answer to a scope or safety question. The first key the dialog receives stops the timer. Config moves to `~/.pi/agent/configs/ask-user-question.json`.
