---
'@nicknisi/pi-relay': minor
---

Append-only audit log written from the deposit/deliver choke points (mailbox.ts) so drain-as-receipt no longer destroys evidence. Every send/ask/reply/cancel/deliver appends one line-delimited JSON record to `<PI_RELAY_DIR>/audit.log` with timestamp, event, kind, from/to addresses, and message id — never the full body (≤80-char preview only). New `/relay log [N]` command renders the last N entries (default 50); survives corrupt lines and is `0600`/append-only.
