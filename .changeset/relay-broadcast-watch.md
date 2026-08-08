---
'@nicknisi/pi-relay': minor
---

Broadcast and presence watch. `send` with `to: "*"` fans out to every other session and `to: "cwd"` to sessions in this session's cwd — implemented as N atomic deposits through the existing deposit path so the rate cap still bounds total fan-out; dedupe is now per-peer (loop-breaking stays per-peer) so one body reaches distinct peers instead of being dropped after the first, and each delivery gets its own audit line + receipt verdict. `watch { to }` subscribes this session to a peer's presence transitions; a 5s unref'd poller surfaces offline↔idle↔working changes as `relay:notify` system messages without waking a busy agent. A standalone `pi relay` CLI is intentionally deferred as a core-runtime concern.
