---
'@nicknisi/pi-fast': minor
---

After a Fast-mode 429 or 529, use standard speed for as long as the response's `retry-after` (or `retry-after-ms`) header asks. pi's automatic retry of the failed request still always goes at standard speed, and a longer cooldown already running is kept. pi 1.6.1 reports failed Anthropic and OpenAI responses to extensions. The fixed 60-second cooldown stays as the fallback when no failed response is reported: older pi, the Codex WebSocket transport, and errors inside an already started stream.
