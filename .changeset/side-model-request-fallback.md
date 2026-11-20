---
'@nicknisi/pi-shared': minor
'@nicknisi/pi-recap': patch
'@nicknisi/pi-heads-up': patch
'@nicknisi/pi-session-name': patch
'@nicknisi/pi-answer': patch
'@nicknisi/pi-btw': patch
---

Retry on the session model when a configured side model fails at request time (for example a deprecated model returning 410). Adds `withSessionFallback` to `@nicknisi/pi-shared`; recap, heads-up, session-name, answer, and btw now use it instead of surfacing the error.
