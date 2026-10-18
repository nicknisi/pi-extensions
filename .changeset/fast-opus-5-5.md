---
'@nicknisi/pi-fast': minor
---

Support Fast mode on Claude Opus 5.5 (generally available, no beta header) and the GPT-6 Codex models. Send the preview beta through the payload's `betas` so pi's own betas are kept (the old header override dropped the mid-conversation effort betas on Opus 5), and fall back to standard speed for 60 seconds after a Fast-mode 429/529.
