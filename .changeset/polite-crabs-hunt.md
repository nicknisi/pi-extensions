---
'@nicknisi/pi-recap': patch
'@nicknisi/pi-session-name': patch
---

Fix model fallback and OAuth auth support in recap and session-name

- Cache the last seen session model from `before_agent_start` and `agent_settled` events so auto-recap can fall back when the agent is idle (`ctx.model` is only set during active turns)
- Fix auth checks to accept OAuth and header-based auth methods, not just API keys (`getApiKeyAndHeaders` returns `ok: true` with `headers` but no `apiKey` for OAuth providers)
