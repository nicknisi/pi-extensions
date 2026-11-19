---
'@nicknisi/pi-recap': patch
---

Recap now reports provider errors and empty summaries as warnings instead of silently doing nothing, aborts in-flight recap requests on session shutdown or when a new turn starts, applies low reasoning effort on every provider, and shows the full recap when the transcript is expanded.
