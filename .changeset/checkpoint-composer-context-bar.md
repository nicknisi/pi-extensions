---
'@nicknisi/pi-checkpoint': minor
---

The context-meter handshake now talks to composer: Checkpoint listens for `composer:context-bar` and asks with `composer:request-context-bar` (formerly `statusline:*`). With composer 1.0 showing a `context` item, Checkpoint colours it and hides its own widget, as it did with statusline.
