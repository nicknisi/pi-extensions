---
'@nicknisi/pi-composer': patch
---

Put the cursor at the end of a message recalled from history. pi-tui places the cursor at the start of an entry recalled with Up, so typing prepends to your own sentence; composer now overrides `navigateHistory` to move the cursor to the end after a successful Up recall. Down navigation, draft restoration, and boundary no-ops (Up at the oldest entry) keep their original cursor behavior.
