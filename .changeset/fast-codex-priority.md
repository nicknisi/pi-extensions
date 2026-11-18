---
'@nicknisi/pi-fast': minor
---

Fix Fast mode on OpenAI Codex: send `service_tier: "priority"`, because the Codex backend rejects `"fast"` with a 400. Add Fast mode for Claude Fable 5.2, Claude Mythos 5.2, GPT-6.1 Terra, GPT-6.2 Astra, and GPT-6.2 Sol, drop the retired GPT-5.5, record Anthropic Fast replies at their 2x cost, and fall back to standard speed for a model when the plan or workspace refuses Fast mode.
