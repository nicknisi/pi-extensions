---
'@nicknisi/pi-relay': patch
---

Fix silent letter loss on delivery failure. `pi.sendMessage` swallows asynchronous errors, so the old drain-then-deliver flow could delete a letter from the inbox without the session ever receiving it, while the sender's receipt still reported "delivered". The inbox now drains through durable claims: a letter is deleted only after the session accepts it, failed deliveries are requeued for retry, crash-stranded claims are recovered on session start, and redeliveries are deduped by message id (seeded from the transcript). Fixes #79.
