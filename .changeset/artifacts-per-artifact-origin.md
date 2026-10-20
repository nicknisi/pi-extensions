---
'@nicknisi/pi-artifacts': patch
---

Each artifact now runs on an origin of its own, so a script in one artifact can't read another artifact's page, source, or share image. In browsers that can't resolve `*.localhost` (Safari), artifacts are sandboxed into an opaque origin instead. The reader's theme and text size are remembered by the review page, so they carry from one artifact to the next.
