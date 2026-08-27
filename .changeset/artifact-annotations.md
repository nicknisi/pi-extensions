---
'@nicknisi/pi-artifacts': minor
---

Add an annotation + feedback loop to artifacts. Served artifact pages now carry an inert comment layer (injected at serve time, never written to the stored file): select text, comment, and submit to send the composed markdown back to the agent as a follow-up message. Comments persist to a `<slug>.annotations.json` sidecar and survive live reloads and restarts; stale comments (whose quoted text no longer appears) are flagged. New endpoints `PUT /api/annotations` and `POST /api/feedback`; markdown artifacts also write a `<slug>.md` source mirror for source-line references.
