---
'@nicknisi/pi-composer': patch
---

Composer no longer re-serializes the whole streamed message on every update, stops the working-message shimmer when the agent settles, queries tmux focus without blocking the TUI, and keeps labels with newlines or tabs on one row. `/composer` now reports that it is TUI-only outside the interactive TUI instead of mounting components there.
