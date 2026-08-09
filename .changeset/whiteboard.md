---
"@nicknisi/pi-whiteboard": minor
---

New package: voice-driven Mermaid diagram generation rendered inline in the terminal — no browser needed.

Opens a TUI overlay (`ctx.ui.custom({ overlay: true })`) for voice/text input. Speak or type descriptions and the active pi model generates Mermaid diagrams with session context. Diagrams are injected into the session via `pi.sendMessage()` and rendered inline by pi's built-in Mermaid markdown transformer.

Three input modes: text, push-to-talk (one-shot transcription via ffmpeg/arecord subprocess → OpenAI Audio API), and continuous streaming voice (OpenAI Realtime API).

Session integration:
- Diagram generation uses `ctx.modelRegistry.complete()` with the active model + recent session messages
- Diagrams injected into session context via `pi.sendMessage()` and rendered inline by pi's mermaid transformer
- `before_agent_start` hook injects current diagram so the agent sees it when the user types
- Agent can push diagrams via `whiteboard` tool (`action: "update"`)
- Agent can read the current diagram via `action: "snapshot"`
- Diagrams persist via `pi.appendEntry()` and restore on session restart
- Voice transcripts needing codebase awareness route to `pi.sendUserMessage()` for the full agent
- No browser, no HTTP server, no WebSocket server — entirely terminal-native
