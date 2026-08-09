/** Lazy localhost HTTP + WebSocket server for the whiteboard extension. */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import { generateMermaid } from './generate.js';
import { RealtimeTranscriber, transcribeBlob } from './transcription.js';
import { whiteboardHtml } from './template.js';

const HOST = '127.0.0.1';

export interface ServerOpts {
  apiKey: string;
  model?: string | undefined;
  baseUrl?: string | undefined;
  transcribeModel?: string | undefined;
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
  opts: ServerOpts;
  generating: AbortController | null;
}

let state: ServerState | null = null;

/** Start the server if not already running. Returns the URL. */
export async function startWhiteboardServer(opts: ServerOpts): Promise<string> {
  if (state) return `http://${HOST}:${state.port}`;

  const server = createServer((req, res) => handleHttp(req, res));
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => handleConnection(ws, opts));

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => {
      server.removeListener('error', reject);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });

  state = { port, server, wss, currentMermaid: null, opts, generating: null };
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

// ─── HTTP handler ─────────────────────────────────────────────────────────────

function handleHttp(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(whiteboardHtml());
}

// ─── WebSocket handler ────────────────────────────────────────────────────────

function handleConnection(ws: WebSocket, opts: ServerOpts): void {
  const clientState: ClientState = {
    pendingAudioFormat: null,
    transcriber: null,
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      handleBinaryMessage(ws, data as Buffer, clientState, opts);
    } else {
      handleTextMessage(ws, data.toString(), clientState, opts).catch(() => {});
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
  opts: ServerOpts,
): Promise<void> {
  let event: { type: string; [key: string]: unknown };
  try {
    event = JSON.parse(msg);
  } catch {
    return;
  }

  switch (event.type) {
    case 'text':
      await handleGenerate(ws, event.text as string, opts);
      break;

    case 'audio':
      // Next binary message will be the audio data
      clientState.pendingAudioFormat = (event.format as string) ?? 'webm';
      break;

    case 'stream_start':
      await handleStreamStart(ws, clientState, opts);
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

function handleBinaryMessage(ws: WebSocket, data: Buffer, clientState: ClientState, opts: ServerOpts): void {
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

    transcribeBlob(data, format, opts)
      .then((transcript) => {
        ws.send(JSON.stringify({ type: 'final', text: transcript }));
        return handleGenerate(ws, transcript, opts);
      })
      .catch((err: unknown) => {
        ws.send(JSON.stringify({ type: 'error', message: String(err) }));
        ws.send(JSON.stringify({ type: 'status', state: 'idle' }));
      });
  }
}

async function handleGenerate(ws: WebSocket, prompt: string, opts: ServerOpts): Promise<void> {
  if (!prompt.trim()) return;

  // Abort any in-flight generation
  if (state?.generating) {
    state.generating.abort();
  }

  const controller = new AbortController();
  if (state) state.generating = controller;

  ws.send(JSON.stringify({ type: 'status', state: 'generating' }));

  try {
    const mermaid = await generateMermaid({
      prompt,
      currentMermaid: state?.currentMermaid ?? null,
      apiKey: opts.apiKey,
      model: opts.model,
      baseUrl: opts.baseUrl,
      signal: controller.signal,
    });

    if (state) state.currentMermaid = mermaid;

    ws.send(JSON.stringify({ type: 'mermaid', code: mermaid }));
    ws.send(JSON.stringify({ type: 'status', state: 'idle' }));
  } catch (err) {
    if (controller.signal.aborted) return; // aborted, not an error
    ws.send(JSON.stringify({ type: 'error', message: String(err) }));
    ws.send(JSON.stringify({ type: 'status', state: 'idle' }));
  } finally {
    if (state?.generating === controller) state.generating = null;
  }
}

async function handleStreamStart(ws: WebSocket, clientState: ClientState, opts: ServerOpts): Promise<void> {
  if (clientState.transcriber) return; // already streaming

  clientState.transcriber = new RealtimeTranscriber({
    apiKey: opts.apiKey,
    model: opts.transcribeModel,
    onPartial: (text) => {
      ws.send(JSON.stringify({ type: 'partial', text }));
    },
    onFinal: (text) => {
      ws.send(JSON.stringify({ type: 'final', text }));
      // Generate on each final transcript (phrase-level updates)
      handleGenerate(ws, text, opts).catch(() => {});
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
