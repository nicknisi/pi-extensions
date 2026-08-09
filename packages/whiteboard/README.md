# @nicknisi/pi-whiteboard

Voice-driven whiteboarding with real-time Mermaid diagram generation.

Opens a browser-based whiteboard where you can type or **speak** descriptions of diagrams and see them rendered as Mermaid diagrams in real-time. As you describe what you want to build, an LLM generates the Mermaid code and the diagram updates live. Course-correct mid-conversation — "no, make the gateway a circle instead" — and the diagram updates immediately.

## What it adds

- **`/whiteboard` command** — opens the whiteboard UI in the browser
- **`whiteboard` tool** — LLM-callable tool to open the whiteboard programmatically

## Usage

```
/whiteboard
```

This opens a browser window with:

- A **text input** where you can type diagram descriptions
- A **Push to Talk** button for one-shot voice transcription (hold to record, release to transcribe)
- A **Continuous** button for real-time streaming voice mode (hands-free, diagram updates as you speak)
- A live **transcript panel** showing what you said
- The rendered **Mermaid diagram** area

### Text mode

Type a description and press Enter or click Send:

> "draw a system architecture with a client, API gateway, and three microservices connected to a shared database"

The diagram appears within ~1-2 seconds. Then type corrections:

> "no, make the gateway a circle and add a cache layer between the gateway and the services"

The diagram updates, preserving existing elements.

### Push-to-talk mode

Hold the **Push to Talk** button, speak your description, then release. The audio is transcribed via OpenAI's `gpt-4o-mini-transcribe` and the diagram is generated from the transcript. ~2-4 seconds from release to rendered diagram.

### Continuous mode

Click **Continuous** to start hands-free streaming voice mode. The browser captures audio via `AudioWorklet` (resampled to PCM16 24kHz) and streams it to the OpenAI Realtime API. As you speak, the transcript appears in the transcript panel and the diagram updates phrase-by-phrase at natural pause boundaries. Course-correct by just saying "no, actually..." — the diagram regenerates.

Click **Stop** (same button) to end the streaming session.

## How it works

```
Browser (localhost)                    Pi extension (Node.js)
┌──────────────────────┐               ┌──────────────────────────┐
│ getUserMedia         │── audio ──►   │ WebSocket server         │
│ AudioWorklet         │  (binary)     │                          │
│ (PCM16 24kHz)        │               │ ├── One-shot:            │
│                      │               │ │   transcribeBlob()     │
│ Mermaid.js render    │◄── mermaid ── │ │   → generateMermaid() │
│                      │   (JSON)      │                          │
│ Transcript display   │◄── partial ── │ ├── Streaming:           │
│                      │   (JSON)      │ │   RealtimeTranscriber  │
│                      │               │ │   → generateMermaid() │
└──────────────────────┘               │                          │
                                       │ generateMermaid() calls   │
                                       │ OpenAI chat completions   │
                                       └──────────────────────────┘
                                                │
                                                ▼
                                       wss://api.openai.com
                                       (transcription + LLM)
```

- **Text path:** browser sends text → LLM generates Mermaid → browser renders
- **Push-to-talk:** browser records audio (MediaRecorder) → server sends blob to OpenAI Audio API → transcript → LLM generates Mermaid → browser renders
- **Continuous:** browser streams PCM16 audio via AudioWorklet → server forwards to OpenAI Realtime WebSocket → partial/final transcripts → LLM generates Mermaid on each final phrase → browser renders

## Configuration

No configuration needed. The extension resolves the OpenAI API key from pi's model registry (`getProviderAuth('openai')`).

### Defaults

| Setting                         | Default                  | Notes                                            |
| ------------------------------- | ------------------------ | ------------------------------------------------ |
| LLM model                       | `gpt-4o-mini`            | Fast and cost-effective for real-time generation |
| Transcription model (one-shot)  | `gpt-4o-mini-transcribe` | Used by Push to Talk                             |
| Transcription model (streaming) | `gpt-4o-transcribe`      | Used by Continuous mode                          |
| Host                            | `127.0.0.1`              | Localhost only                                   |
| Port                            | ephemeral (port 0)       | No conflicts                                     |

## Requirements

- An OpenAI API key configured in pi (the extension checks for it on launch)
- A browser (opened automatically via `open` / `xdg-open` / `rundll32`)
- Microphone access (for voice features — localhost is a secure context, so `getUserMedia` works)

## Dependencies

- `ws` — WebSocket server (and client for OpenAI Realtime API)

## Caveats

- **API key:** The extension requires an OpenAI API key for both transcription and LLM generation. If your pi setup uses a different provider (e.g., Anthropic only), voice features won't work.
- **Latency:** Real-time here means ~2-4 seconds from speech to rendered diagram (VAD pause detection + transcription + LLM generation + Mermaid render). It's conversational, not word-by-word.
- **Mermaid from CDN:** The browser UI loads Mermaid.js from `cdn.jsdelivr.net`. Requires internet access on the browser machine.
- **Audio format:** Push-to-talk uses `MediaRecorder` (WebM/Opus in most browsers). Continuous mode uses `AudioWorklet` to produce raw PCM16 at 24kHz. Both are handled server-side.
- **Cost:** Transcription is ~$0.006/min for `gpt-4o-transcribe` and ~$0.003/min for `gpt-4o-mini-transcribe`. LLM generation with `gpt-4o-mini` is pennies per session. Continuous streaming for a long whiteboarding session costs cents.
- **Session lifecycle:** The server starts lazily on `/whiteboard` or the tool call, and stops on session shutdown. One server per pi session.
