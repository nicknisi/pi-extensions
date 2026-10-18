---
'@nicknisi/pi-relay': minor
---

Add an optional `wake` field to `Letter`. A letter with `wake: false` is delivered into the receiving session's context without triggering a model turn; absent or `true` wakes the session as before. An ask is never quiet: core `deposit` refuses `wake: false` on an ask, and delivery wakes an ask regardless, since the receiver must take a turn to answer. Backward compatible: old readers ignore the field, old writers never set it, and a letter whose `wake` is not a boolean is still delivered as waking mail rather than dropped. Core `deposit` validates that `wake`, when present, is a boolean.
