---
'@nicknisi/pi-artifacts': minor
---

Expose an optional session-scoped artifacts service for direct HTML publishing, question answers, and owned async feedback. Preserve the ordinary tool route and prevent concurrent feedback delivery from duplicating or erasing drafts.

Fix artifact pages that never finished loading once a few were open: each tab held two permanent live-update streams, exhausting the browser's per-host connection limit. Pages now share one stream, release it while hidden, and replay missed reloads and annotation changes on return; already-written pages are upgraded when served.
