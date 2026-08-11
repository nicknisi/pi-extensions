---
'@nicknisi/pi-composer': minor
---

Add an extension API for the border inlay over pi's shared event bus (`pi.events`). Other extensions can push label text with `pi.events.emit('composer:set-label', { text })` (absent/empty text clears it, falling back to the session name), and composer emits `composer:label-request` on every session start so producers can re-push regardless of extension load order. Pushed labels go through the same format/colour/position/truncation pipeline as the session name.
