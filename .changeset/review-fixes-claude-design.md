---
'@nicknisi/pi-claude-design': patch
---

`/design-login` now shows the authorization URL and no longer crashes pi when no browser opener is available. Token refreshes are serialized across processes, credentials are written atomically with mode 0600, token requests time out after 15s, and malformed credential files are treated as logged out.
