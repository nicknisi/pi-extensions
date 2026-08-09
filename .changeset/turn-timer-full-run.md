---
'@nicknisi/pi-turn-timer': patch
---

Time complete runs (agent_start → agent_settled) instead of individual turns (turn_start → turn_end). A turn is one LLM response plus its tool calls, so a run with multiple tool-call rounds emitted one timer row per round. Now one row is emitted per user message, covering the full wall-clock from message sent to agent idle.
