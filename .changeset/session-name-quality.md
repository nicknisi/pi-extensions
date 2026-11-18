---
'@nicknisi/pi-session-name': minor
---

Wait for a prompt with at least three words before auto-naming, so sessions that open with "ok" or "hello" are no longer named "Empty start" or "No clear task". Strip markdown emphasis from LLM titles, and replace control and bidi characters in session names and terminal titles, which Pi writes inside an escape sequence.
