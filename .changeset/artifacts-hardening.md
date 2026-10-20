---
'@nicknisi/pi-artifacts': patch
---

Harden the artifact server: refuse requests whose `Host` isn't the server itself (blocks DNS rebinding), pin mermaid to an exact version with an integrity hash, and restart on the project's previous port so tabs left open across a restart or `/new` reconnect and keep their drafts.
