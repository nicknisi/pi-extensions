---
'@nicknisi/pi-intercom': minor
---

New package: brokerless session-to-session messaging (drop-in replacement for nicobailon/pi-intercom). File mailbox under `~/.pi/agent/intercom/` — no daemon; addresses survive `pi -c` resume; offline sessions collect mail on return; consumption-is-the-receipt delivery; pid+heartbeat presence; structural loop-breaking; authority-boundary preamble on every delivery. One `intercom` tool (list, list-cwd, send, ask, reply, pending, cancel, status) plus `/intercom`.
