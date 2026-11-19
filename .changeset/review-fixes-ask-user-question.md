---
'@nicknisi/pi-ask-user-question': patch
---

Aborting an `ask_user_question` call in an RPC host now closes the host's open dialog and cancels the questionnaire instead of waiting for an answer. The questionnaire UI is now pre-warmed only in interactive terminal sessions, and the README's reference docs ship with the package.
