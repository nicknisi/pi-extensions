# @nicknisi/pi-whiteboard

Voice-driven whiteboarding with real-time Mermaid diagram generation, integrated with the pi coding session.

Opens a browser-based whiteboard where you can type or **speak** descriptions of diagrams and see them rendered as Mermaid diagrams in real-time. The diagram generation uses the **active model** (same one as your pi agent) with **session context** — it knows what you've been working on. Diagrams flow back into the pi session so the agent can see them and act on them.

## What it adds

- **`/whiteboard` command** — opens the whiteboard UI in the browser
- **`whiteboard` tool** — LLM-callable tool with four actions:
  - `open` — launch the whiteboard
  - `update` — push a Mermaid diagram to the whiteboard (agent → user)
  - `snapshot` — read the current diagram back (agent reads what the user drew)
  - `status` — check if the whiteboard is running

## How it's different from a standalone app

The whiteboard is **not a side channel** — it's integrated with the pi session in five ways:

1. **Diagram generation uses the active model with session context.** When you say "make the gateway a circle," the model knows what "the gateway" is because it can see your recent conversation. It's the agent's brain, called directly — no agent loop, ~1-2s latency.

2. **Diagrams flow back into the session.** Each voice-generated diagram is injected into session context via `pi.sendMessage()` with `deliverAs: "nextTurn"` — available when you type your next prompt, but doesn't trigger the agent on its own.

3. **`before_agent_start` injects the current diagram.** When you type "build it" in pi, the agent sees the current whiteboard diagram in its context automatically.

4. **The agent can push diagrams to the whiteboard.** The agent can analyze your codebase, generate a Mermaid diagram, and push it to the whiteboard via `action: "update"`. The browser live-reloads.

5. **The agent can read the whiteboard.** Via `action: "snapshot"`, the agent can read the current diagram and act on it — e.g., "I see your architecture, want me to scaffold it?"

6. **Diagrams persist with the session.** Via `pi.appendEntry()`, the current diagram survives restarts. On `/resume`, the whiteboard restores the last diagram.

## Usage

```
/whiteboard
```

This opens a browser window with:
- A **text input** for typing diagram descriptions
- A **Push to Talk** button for one-shot voice transcription
- A **Continuous** button for real-time streaming voice mode
- A live **transcript panel**
- The rendered **Mermaid diagram**

### The collaborative flow

```
You (pi prompt): "whiteboard the architecture of this project"
  → agent explores codebase, generates initial Mermaid
  → agent calls whiteboard tool (action: "update") → browser renders
  → agent says: "I've mapped out 3 services and a gateway. Take over with voice."

You (voice): "make the gateway a circle"
  → transcribe → active model generates updated Mermaid with session context
  → browser live-reloads → diagram injected into session context

You (voice): "add a cache between the gateway and service 2"
  → same fast loop → diagram updates

You (voice): "actually, based on the auth middleware, should we add an auth service?"
  → whiteboard detects this needs the agent → routes to pi.sendUserMessage()
  → agent: "Looking at your auth middleware... yes, I'd extract it. [pushes updated diagram]"

You (pi prompt): "ok, build it"
  → agent has the final diagram in context (via before_agent_start injection)
  → starts scaffolding
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
Browser (localhost)                    Pi extension (Node.js)
┌──────────────────────┐               ┌──────────────────────────┐
│ getUserMedia         │── audio ──►   │ WebSocket server         │
│ AudioWorklet         │  (binary)     │                          │
│ (PCM16 24kHz)        │               │ ├── Transcription:       │
│                      │               │ │   OpenAI Realtime API  │
│ Mermaid.js render    │◄── mermaid ── │ │   (or one-shot blob)   │
│                      │   (JSON)      │                          │
│ Transcript display   │◄── partial ── │ ├── Generation:          │
│                      │   (JSON)      │ │   ctx.modelRegistry    │
│                      │               │ │   .complete() with     │
└──────────────────────┘               │ │   session context      │
                                       │                          │
                                       │ ├── Session injection:   │
                                       │ │   pi.sendMessage()     │
                                       │ │   pi.appendEntry()     │
                                       │ │   before_agent_start   │
                                       │                          │
                                       │ ├── Agent routing:       │
                                       │ │   pi.sendUserMessage() │
                                       │ │   (for codebase-aware  │
                                       │ │    requests)           │
                                       │                          │
                                       │ └── Agent → whiteboard:  │
                                       │     pushMermaid() via    │
                                       │     whiteboard tool      │
                                       └──────────────────────────┘
```

### Key design: the active model, not a disconnected LLM

Diagram generation calls `ctx.modelRegistry.complete(ctx.model, context)` — the **same model** the agent uses, with **recent session messages** as context. This means:

- "Make it like the auth service" → knows what the auth service is
- "Add the service we discussed" → knows which service you mean
- Corrections understand the existing diagram in context

The voice pipeline calls the model directly (no agent loop, no tool calls) for ~1-2s latency. When a transcript needs codebase awareness, it routes to `pi.sendUserMessage()` for the full agent experience.

## Configuration

No configuration needed. The extension resolves the OpenAI API key from pi's model registry (`getProviderAuth('openai')`) for transcription, and uses the active model for diagram generation.

### Defaults

| Setting | Default | Notes |
|---------|---------|-------|
| LLM model | Active pi model | Same model as the agent — uses `ctx.model` |
| Transcription model (one-shot) | `gpt-4o-mini-transcribe` | Used by Push to Talk |
| Transcription model (streaming) | `gpt-4o-transcribe` | Used by Continuous mode |
| Host | `127.0.0.1` | Localhost only |
| Port | ephemeral (port 0) | No conflicts |
| Session context | Last 5 user messages | Included in generation context |

## Requirements

- An OpenAI API key configured in pi (for transcription — the Realtime API and one-shot audio API)
- An active model configured in pi (for diagram generation — any model that supports completions)
- A browser (opened automatically)
- Microphone access (for voice features — localhost is a secure context)

## Dependencies

- `ws` — WebSocket server (and client for OpenAI Realtime API)
- `typebox` — schema definitions for tool parameters

## Caveats

- **Two API surfaces:** Transcription uses OpenAI (Realtime API + Audio API). Diagram generation uses whatever model is active in pi. If your active model is Anthropic, voice transcription still needs an OpenAI key, but diagram generation uses Claude.
- **Latency:** Real-time here means ~2-4 seconds from speech to rendered diagram (VAD pause + transcription + LLM generation + Mermaid render). It's conversational, not word-by-word.
- **Mermaid from CDN:** The browser UI loads Mermaid.js from `cdn.jsdelivr.net`. Requires internet access on the browser machine.
- **Session context size:** Only the last 5 user messages are included in the generation context to avoid token bloat. If the relevant context is older, the model may not have it.
- **Agent routing heuristic:** The `shouldRouteToAgent` check is a simple regex. Complex phrasing may misroute. When in doubt, the user can always type in pi directly.
- **Cost:** Transcription is ~$0.006/min (streaming) or ~$0.003/min (one-shot). Diagram generation cost depends on the active model.
- **Session lifecycle:** The server starts lazily on `/whiteboard` or the tool call, and stops on session shutdown. One server per pi session.
