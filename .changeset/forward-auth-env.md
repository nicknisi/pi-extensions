---
'@nicknisi/pi-btw': patch
'@nicknisi/pi-answer': patch
'@nicknisi/pi-handoff': patch
---

Forward `env` from `getApiKeyAndHeaders()` to the side-model stream so providers that resolve endpoint placeholders from it (Cloudflare AI Gateway, Workers AI) stop 401ing.

`btw` now builds its side-thread context from `buildContextEntries()` (compaction applied, with the summary carried as a leading message) instead of the raw branch, so long sessions no longer exceed the model window (`400 prompt is too long`).
