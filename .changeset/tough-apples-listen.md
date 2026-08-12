---
'@nicknisi/pi-relay': patch
---

Close Relay filesystem TOCTOU gaps by rejecting symlinked root ancestors and pinning root and child directory descriptors across record, alias, audit, mailbox, ask, receipt, and watch operations. Use descriptor-relative Unix syscalls while preserving atomic deposits and clean descriptor shutdown.
