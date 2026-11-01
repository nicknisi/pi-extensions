---
'@nicknisi/pi-handoff': patch
---

Cap the conversation sent to the model at ~70% of its context window (dropping the oldest messages first) so long sessions no longer overflow. The handoff prompt now quotes your last few requests verbatim, tells the new session to verify git and file state before acting, and points it at the session JSONL files for grep instead of `pi --session`.
