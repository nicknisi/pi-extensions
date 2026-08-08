---
'@nicknisi/pi-relay': minor
---

New package: brokerless session-to-session messaging (renamed from the briefly-published `@nicknisi/pi-intercom@0.0.0`, itself a drop-in replacement for nicobailon/pi-intercom). File mailbox under `~/.pi/agent/relay/` — no daemon; addresses survive `pi -c` resume; offline sessions collect mail on return; consumption-is-the-receipt delivery; pid+heartbeat presence; structural loop-breaking; authority-boundary preamble on every delivery. One `relay` tool (list, list-cwd, send, ask, reply, pending, cancel, status) plus `/relay`.
