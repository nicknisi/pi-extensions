---
'@nicknisi/pi-artifacts': patch
---

Ship `events.ts` in the published package. 1.5.0 and 1.5.1 omitted it from `files`, so pi failed to load the extension from npm with `Cannot find module './events.js'`.
