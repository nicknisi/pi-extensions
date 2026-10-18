---
'@nicknisi/pi-workflows': patch
'@nicknisi/pi-shared': minor
---

Fan-outs share one prompt-cache write: matching workflow agents that start together wait (at most 5 seconds) for the first one's response to start, so they read its cached prefix instead of each writing their own. The shared runtime gains an `onResponseStart` callback.
