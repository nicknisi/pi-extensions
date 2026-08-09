---
"@nicknisi/pi-whiteboard": minor
---

New package: voice-driven whiteboarding with real-time Mermaid diagram generation, integrated with the pi session.

Opens a browser-based whiteboard where you type or speak descriptions and the **active pi model** generates Mermaid diagrams with **session context** — it knows what you've been working on. Diagrams flow back into the session so the agent can see and act on them.

Three input modes: text, push-to-talk (one-shot transcription), and continuous streaming voice (OpenAI Realtime API).

Session integration:
- Diagram generation uses `ctx.modelRegistry.complete()` with the active model + recent session messages
- Diagrams injected into session context via `pi.sendMessage()` (available for next prompt, doesn't trigger agent)
- `before_agent_start` hook injects current diagram so the agent sees it when the user types
- Agent can push diagrams to the whiteboard via `whiteboard` tool (`action: "update"`)
- Agent can read the current diagram via `action: "snapshot"`
- Diagrams persist via `pi.appendEntry()` and restore on session restart
- Voice transcripts needing codebase awareness route to `pi.sendUserMessage()` for the full agent
