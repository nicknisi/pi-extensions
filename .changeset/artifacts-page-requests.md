---
'@nicknisi/pi-artifacts': minor
---

Pages served by the artifacts service can ask their owning session to act. A subscriber lists the `actions` it accepts and an `onRequest` callback; elements marked `data-artifact-action` are revealed and wired only while that action has a live owner, and each click sends a same-origin, host-checked request. Requests are never permission — owners confirm in their own UI before acting.
