---
'@nicknisi/pi-answer': patch
---

`/answer` now reports extraction request failures instead of silently falling back, no longer crashes in RPC mode, tolerates malformed model output, and its regex fallback no longer splits questions on dotted words or matches `?` in code and URLs. The answer hint retries classifier lookup after a later login and cancels pending classifier calls on new input or shutdown.
