/** Lazy localhost HTTP + WebSocket server for the whiteboard extension. */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import { RealtimeTranscriber, transcribeBlob } from './transcription.js';
import { whiteboardHtml } from './template.js';

const HOST = '127.0.0.1';

/** Callbacks the extension provides — the server has no knowledge of pi internals. */
export interface ServerCallbacks {
  /** Generate Mermaid from a prompt using the active model + session context. */
  generate: (prompt: string, currentMermaid: string | null) => Promise<string>;
  /** Called when a new diagram is generated (for session injection + persistence). */
  onDiagramGenerated: (mermaid: string, prompt: string) => void;
  /** Should this transcript be routed to the full agent instead of direct generation? */
  shouldRouteToAgent: (transcript: string) => boolean;
  /** Route a transcript to the agent as a user message. */
  routeToAgent: (transcript: string) => void;
  /** OpenAI API key for transcription (Realtime API + one-shot). */
  transcriptionApiKey: string;
  /** Base URL for OpenAI transcription API. */
  transcriptionBaseUrl: string;
  /** Transcription model for one-shot (push-to-talk). */
  transcribeModel?: string | undefined;
  /** Transcription model for streaming (continuous). */
  streamTranscribeModel?: string | undefined;
}

interface ClientState {
  pendingAudioFormat: string | null;
  transcriber: RealtimeTranscriber | null;
}

interface ServerState {
  port: number;
  server: Server;
  wss: WebSocketServer;
  currentMermaid: string | null;
  callbacks: ServerCallbacks;
  generating: AbortController | null;
}

let state: ServerState | null = null;

/** Start the server if not already running. Returns the URL. */
export async function startWhiteboardServer(callbacks: ServerCallbacks): Promise<string> {
  if (state) return `http://${HOST}:${state.port}`;

  const server = createServer((req, res) => handleHttp(req, res));
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => handleConnection(ws, callbacks));

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => {
      server.removeListener('error', reject);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });

  state = { port, server, wss, currentMermaid: null, callbacks, generating: null };
  return `http://${HOST}:${port}`;
}

/** Stop the server (used on session shutdown). */
export function stopWhiteboardServer(): void {
  if (!state) return;
  for (const client of state.wss.clients) {
    try {
      client.close();
    } catch {
      // Ignore
    }
  }
  state.wss.close();
  state.server.close();
  state = null;
}

/** Whether the server is currently running. */
export function isWhiteboardRunning(): boolean {
  return state !== null;
}

/** Get the current Mermaid diagram (for the snapshot tool). */
export function getCurrentMermaid(): string | null {
  return state?.currentMermaid ?? null;
}

/** Push a Mermaid diagram to all connected browsers (agent → whiteboard). */
export function pushMermaid(mermaid: string): void {
  if (!state) return;
  state.currentMermaid = mermaid;
  for (const client of state.wss.clients) {
    try {
      client.send(JSON.stringify({ type: 'mermaid', code: mermaid }));
    } catch {
      // Ignore
    }
  }
}

// ─── HTTP handler ─────────────────────────────────────────────────────────────

function handleHttp(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(whiteboardHtml());
}

// ─── WebSocket handler ────────────────────────────────────────────────────────

function handleConnection(ws: WebSocket, callbacks: ServerCallbacks): void {
  const clientState: ClientState = {
    pendingAudioFormat: null,
    transcriber: null,
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      handleBinaryMessage(ws, data as Buffer, clientState, callbacks);
    } else {
      handleTextMessage(ws, data.toString(), clientState, callbacks).catch(() => {});
    }
  });

  ws.on('close', () => {
    if (clientState.transcriber) {
      clientState.transcriber.stop().catch(() => {});
    }
  });

  // Send current diagram if one exists
  if (state?.currentMermaid) {
    ws.send(JSON.stringify({ type: 'mermaid', code: state.currentMermaid }));
  }
}

async function handleTextMessage(
  ws: WebSocket,
  msg: string,
  clientState: ClientState,
  callbacks: ServerCallbacks,
): Promise<void> {
  let event: { type: string; [key: string]: unknown };
  try {
    event = JSON.parse(msg);
  } catch {
    return;
  }

  switch (event.type) {
    case 'text':
      await handleGenerate(ws, event.text as string, callbacks);
      break;

    case 'audio':
      // Next binary message will be the audio data
      clientState.pendingAudioFormat = (event.format as string) ?? 'webm';
      break;

    case 'stream_start':
      await handleStreamStart(ws, clientState, callbacks);
      break;

    case 'stream_stop':
      await handleStreamStop(ws, clientState);
      break;

    case 'clear':
      if (state) state.currentMermaid = null;
      ws.send(JSON.stringify({ type: 'mermaid', code: '' }));
      break;
  }
}

function handleBinaryMessage(ws: WebSocket, data: Buffer, clientState: ClientState, callbacks: ServerCallbacks): void {
  // In streaming mode, forward audio to transcriber
  if (clientState.transcriber) {
    clientState.transcriber.sendAudio(data);
    return;
  }

  // One-shot audio blob (push-to-talk mode)
  if (clientState.pendingAudioFormat) {
    const format = clientState.pendingAudioFormat;
    clientState.pendingAudioFormat = null;

    ws.send(JSON.stringify({ type: 'status', state: 'transcribing' }));

    transcribeBlob(data, format, {
      apiKey: callbacks.transcriptionApiKey,
      baseUrl: callbacks.transcriptionBaseUrl,
      model: callbacks.transcribeModel,
    })
      .then((transcript) => {
        ws.send(JSON.stringify({ type: 'final', text: transcript }));
        return handleTranscript(ws, transcript, callbacks);
      })
      .catch((err: unknown) => {
        ws.send(JSON.stringify({ type: 'error', message: String(err) }));
        ws.send(JSON.stringify({ type: 'status', state: 'idle' }));
      });
  }
}

/** Process a transcript — route to agent or generate Mermaid directly. */
async function handleTranscript(ws: WebSocket, transcript: string, callbacks: ServerCallbacks): Promise<void> {
  if (!transcript.trim()) return;

  // If the transcript needs the agent's codebase awareness, route it
  if (callbacks.shouldRouteToAgent(transcript)) {
    ws.send(JSON.stringify({ type: 'status', state: 'routing' }));
    callbacks.routeToAgent(transcript);
    ws.send(JSON.stringify({ type: 'status', state: 'idle' }));
    return;
  }

  // Otherwise, generate Mermaid directly using the active model
  await handleGenerate(ws, transcript, callbacks);
}

async function handleGenerate(ws: WebSocket, prompt: string, callbacks: ServerCallbacks): Promise<void> {
  if (!prompt.trim()) return;

  // Abort any in-flight generation
  if (state?.generating) {
    state.generating.abort();
  }

  const controller = new AbortController();
  if (state) state.generating = controller;

  ws.send(JSON.stringify({ type: 'status', state: 'generating' }));

  try {
    const mermaid = await callbacks.generate(prompt, state?.currentMermaid ?? null);

    if (state) state.currentMermaid = mermaid;

    ws.send(JSON.stringify({ type: 'mermaid', code: mermaid }));
    ws.send(JSON.stringify({ type: 'status', state: 'idle' }));

    // Notify the extension (inject into session + persist)
    callbacks.onDiagramGenerated(mermaid, prompt);
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: String(err) }));
    ws.send(JSON.stringify({ type: 'status', state: 'idle' }));
  } finally {
    if (state?.generating === controller) state.generating = null;
  }
}

async function handleStreamStart(ws: WebSocket, clientState: ClientState, callbacks: ServerCallbacks): Promise<void> {
  if (clientState.transcriber) return; // already streaming

  clientState.transcriber = new RealtimeTranscriber({
    apiKey: callbacks.transcriptionApiKey,
    model: callbacks.streamTranscribeModel,
    onPartial: (text) => {
      ws.send(JSON.stringify({ type: 'partial', text }));
    },
    onFinal: (text) => {
      ws.send(JSON.stringify({ type: 'final', text }));
      // Generate on each final transcript (phrase-level updates)
      handleTranscript(ws, text, callbacks).catch(() => {});
    },
    onError: (err) => {
      ws.send(JSON.stringify({ type: 'error', message: String(err) }));
    },
  });

  try {
    await clientState.transcriber.connect();
    ws.send(JSON.stringify({ type: 'status', state: 'streaming' }));
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: String(err) }));
    clientState.transcriber = null;
  }
}

async function handleStreamStop(ws: WebSocket, clientState: ClientState): Promise<void> {
  if (clientState.transcriber) {
    await clientState.transcriber.stop();
    clientState.transcriber = null;
  }
  ws.send(JSON.stringify({ type: 'status', state: 'idle' }));
}
