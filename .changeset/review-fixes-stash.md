---
'@nicknisi/pi-stash': patch
---

Auto-restore now only happens after you submit a prompt from the editor, not when another extension starts a run, and the extension is now inactive outside the TUI so RPC sessions can no longer claim and lose stashed drafts. The README install instructions now use the npm package.
