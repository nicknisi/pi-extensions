---
'@nicknisi/pi-llm-council': patch
'@nicknisi/pi-relay': patch
---

Drop `uniqueItems` from the `llm_council` and `relay` tool schemas. OpenAI strict function schemas reject the keyword, which broke every request in GPT sessions with a 400. Duplicate council members are still rejected at runtime, and relay already ignores duplicate session IDs.
