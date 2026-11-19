---
'@nicknisi/pi-relay': patch
---

Fix directory listing on Intel Macs (64-bit-inode `readdir`) and refuse 32-bit Linux cleanly, discard malformed letters instead of retrying them forever, and route replies that arrive during an ask's receipt wait to the waiting ask. `watch` now reports idle↔working changes and can no longer crash pi on an unreadable root, `/relay log <non-number>` shows 50 entries, and status stays `working` until pi settles.
