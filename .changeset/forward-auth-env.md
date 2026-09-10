---
'@nicknisi/pi-btw': patch
'@nicknisi/pi-answer': patch
'@nicknisi/pi-handoff': patch
---

Forward `env` from `getApiKeyAndHeaders()` to the side-model stream so providers that resolve endpoint placeholders from it (Cloudflare AI Gateway, Workers AI) stop 401ing.
