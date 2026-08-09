# @nicknisi/pi-whiteboard

Voice-driven Mermaid diagram generation rendered inline in the terminal. No browser — diagrams appear directly in the pi session transcript using pi's built-in Mermaid rendering.

Opens a TUI overlay for voice/text input. Speak or type descriptions and the active pi model generates Mermaid diagrams with session context. Diagrams are injected into the session and rendered inline by pi's Mermaid markdown transformer. The agent can push and read diagrams via the `whiteboard` tool.

## What it adds

- **`/whiteboard` command** — opens a TUI overlay for voice/text-driven diagram generation
- **`whiteboard` tool** — LLM-callable tool with three actions:
  - `update` — push a Mermaid diagram to the whiteboard (renders inline in session)
  - `snapshot` — read the current diagram back
  - `status` — check if a diagram exists

## Usage

```
/whiteboard
```

Opens a floating TUI overlay with:
- **[space]** Push to Talk — hold to record, press again to transcribe
- **[c]** Continuous mode — hands-free streaming voice via OpenAI Realtime API
- **[t]** Text input — type a description
- **[x]** Clear — remove the current diagram
- **[q]** Quit — close the overlay

The diagram renders **inline in the session transcript** — not in the overlay. Pi's built-in Mermaid transformer renders the code block as a Unicode terminal diagram. The overlay is just the voice/text control surface.

### The collaborative flow

```
You (pi prompt): "whiteboard the architecture of this project"
  → agent explores codebase, generates initial Mermaid
  → agent calls whiteboard tool (action: "update") → diagram renders inline in session
  → agent says: "I've mapped out 3 services and a gateway. Take over with voice."

You (/whiteboard, voice): "make the gateway a circle"
  → transcribe → active model generates updated Mermaid with session context
  → diagram renders inline in session → injected into session context

You (voice): "add a cache between the gateway and service 2"
  → same fast loop → diagram updates

You (voice): "actually, based on the auth middleware, should we add an auth service?"
  → whiteboard routes to agent → agent thinks → pushes updated diagram

You (pi prompt): "ok, build it"
  → agent has the final diagram in context → starts scaffolding
```

### When voice routes to the agent vs. generates directly

Voice transcripts are routed to the full agent (via `pi.sendUserMessage()`) when they contain:
- Questions: "should we...", "what if...", "can we..."
- Codebase references: "based on...", "from the codebase..."
- Action requests: "build it", "scaffold", "generate the code", "create the files"
- Opinion requests: "what do you think", "how should we..."

Everything else generates Mermaid directly via the active model — fast iteration without the agent loop.

## Architecture

```
TUI Overlay (ctx.ui.custom)           Pi Session (Node.js)
┌──────────────────────┐               ┌──────────────────────────┐
│ [space] push to talk │               │ ctx.modelRegistry        │
│ [c] continuous       │   transcript  │   .complete()            │
│ [t] text             │──────────────►│   + session context      │
│ [x] clear            │               │                          │
│                      │               │ pi.sendMessage()         │
│ Status:              │◄──────────────│   → renders inline       │
│  ◉ Listening...      │   mermaid     │   via mermaid transformer│
│  ✦ Generating...     │   (injected)  │                          │
│                      │               │ pi.appendEntry()         │
│ "make gateway circle"│               │   → persist + restore    │
└──────────────────────┘               │                          │
        │                              │ before_agent_start       │
        │ audio (subprocess)           │   → inject diagram       │
        ▼                              │     into agent context   │
 sox / ffmpeg                          │                          │
 PCM16 24kHz                           │ pi.sendUserMessage()     │
        │                              │   → route to agent       │
        ▼                              │     (codebase-aware)     │
 OpenAI Realtime API                   └──────────────────────────┘
 gpt-4o-transcribe
```

### Key design: the active model, not a disconnected LLM

Diagram generation calls `ctx.modelRegistry.complete(ctx.model, context)` — the **same model** as the agent, with **recent session messages** as context. This means:

- "Make it like the auth service" → knows what the auth service is
- "Add the service we discussed" → knows which service you mean
- Corrections understand the existing diagram in context

### Key design: no browser, no server

The whiteboard is entirely terminal-native:
- Audio capture via `ffmpeg` (macOS) or `arecord` (Linux) subprocess
- Mermaid rendering via pi's built-in `createMermaidMarkdownTransformer`
- TUI overlay via `ctx.ui.custom({ overlay: true })`
- No HTTP server, no WebSocket server, no browser, no HTML

## Requirements

- An OpenAI API key configured in pi (for transcription)
- An active model configured in pi (for diagram generation)
- `ffmpeg` (macOS) or `arecord` (Linux) for audio capture
- Interactive TUI mode (`pi` without `-p` or `--json`)

## Dependencies

- `ws` — WebSocket client for OpenAI Realtime API
- `typebox` — schema definitions for tool parameters

## Caveats

- **Audio capture:** Uses `ffmpeg` on macOS (AVFoundation) and `arecord` on Linux. The extension checks for availability on launch. Windows is not yet supported (DShow path exists but is untested).
- **Two API surfaces:** Transcription uses OpenAI (Realtime API + Audio API). Diagram generation uses whatever model is active in pi. If your active model is Anthropic, voice transcription still needs an OpenAI key, but diagram generation uses Claude.
- **Latency:** ~2-4 seconds from speech to rendered diagram (VAD pause + transcription + LLM generation + Mermaid render).
- **Mermaid rendering:** Depends on pi's `markdown.mermaid` setting. Default is `"streaming"` which renders diagrams as Unicode art. Set to `"off"` to disable.
- **Session context size:** Last 5 user messages included in generation context.
- **Overlay lifecycle:** The overlay is disposed when closed. Audio processes are cleaned up on quit.
- **Cost:** Transcription ~$0.006/min (streaming) or ~$0.003/min (one-shot). Generation cost depends on active model.
