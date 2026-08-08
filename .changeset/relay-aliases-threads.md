---
'@nicknisi/pi-relay': minor
---

Durable claimable aliases and explicit thread tokens. `claim { to: "@ci" }` binds an @alias to this session's address — persisted in the registry (survives restart), last-claim-wins, swept when the owning session's record is reaped (resumable-but-offline keeps both). Any session can target `to: "@ci"`. Thread tokens are now explicit: every send/ask returns its message id and `reply` requires `replyTo` (the ask/message id or unique prefix) — the inferred-single-pending-ask fallback is removed so identical calls no longer change semantics based on invisible broker state.
