---
'@nicknisi/pi-relay': patch
---

Close Relay filesystem TOCTOU gaps by rejecting user-controlled symlinked root ancestors, safely canonicalizing protected system aliases such as macOS `/var`, and pinning root and child directory descriptors across record, alias, audit, mailbox, ask, receipt, watch, and durable inbox-claim operations. Mailbox filenames now contain the complete validated message id, preventing same-millisecond prefix collisions and allowing receipts to track the exact letter. Core consumers can atomically claim an inbox, recover stable claim/file tokens after a crash, safely read letters without following symlinks, and acknowledge or requeue them after fsyncing their own journal.
