---
'@nicknisi/pi-sidepulse': patch
---

Shutdown, reload, and session switch now wait at most 0.5s for pending SidePulse reports instead of blocking on a hung CLI or daemon. The README now notes that RPC sessions report too.
