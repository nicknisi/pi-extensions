/** OpenAI Realtime API streaming transcription client. */

import WebSocket from 'ws';

export interface TranscriberOptions {
  /** OpenAI API key. */
  apiKey: string;
  /** Transcription model. Defaults to `gpt-4o-transcribe`. */
  model?: string | undefined;
  /** Called with partial (in-progress) transcript text. */
  onPartial: (text: string) => void;
  /** Called with the final transcript text for a completed utterance. */
  onFinal: (text: string) => void;
  /** Called when an error occurs. */
  onError: (error: Error) => void;
}

/** Streaming transcription via the OpenAI Realtime API (WebSocket). */
export class RealtimeTranscriber {
  private ws: WebSocket | null = null;
  private connected = false;
  private readonly opts: TranscriberOptions;

  constructor(opts: TranscriberOptions) {
    this.opts = opts;
  }

  /** Connect to the OpenAI Realtime transcription endpoint and configure the session. */
  async connect(): Promise<void> {
    const model = this.opts.model ?? 'gpt-4o-transcribe';
    const url = 'wss://api.openai.com/v1/realtime?intent=transcription';

    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        'OpenAI-Beta': 'realtime-v1',
      },
    });

    return new Promise<void>((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('WebSocket not created'));
        return;
      }

      this.ws.on('open', () => {
        this.ws!.send(
          JSON.stringify({
            type: 'transcription_session.update',
            session: {
              type: 'transcription',
              audio: {
                input: {
                  format: { type: 'audio/pcm', rate: 24000 },
                  transcription: { model },
                },
                turn_detection: {
                  type: 'server_vad',
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 500,
                },
              },
            },
          }),
        );
        this.connected = true;
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const event = JSON.parse(data.toString()) as {
            type: string;
            delta?: string;
            transcript?: string;
            error?: { message?: string };
          };
          switch (event.type) {
            case 'conversation.item.input_audio_transcription.delta':
              if (event.delta) this.opts.onPartial(event.delta);
              break;
            case 'conversation.item.input_audio_transcription.completed':
              if (event.transcript) this.opts.onFinal(event.transcript);
              break;
            case 'conversation.item.input_audio_transcription.failed':
              this.opts.onError(new Error(event.error?.message ?? 'Transcription failed'));
              break;
          }
        } catch {
          // Ignore malformed messages
        }
      });

      this.ws.on('error', (err: Error) => {
        if (!this.connected) reject(err);
        else this.opts.onError(err);
      });

      this.ws.on('close', () => {
        this.connected = false;
      });
    });
  }

  /** Send a chunk of PCM16 24kHz mono audio (as a Buffer). */
  sendAudio(pcm16Buffer: Buffer): void {
    if (!this.ws || !this.connected) return;
    const base64 = pcm16Buffer.toString('base64');
    this.ws.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: base64,
      }),
    );
  }

  /** Close the WebSocket connection. */
  async stop(): Promise<void> {
    this.connected = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
  }
}

/** One-shot audio transcription via the OpenAI Audio API. */
export async function transcribeBlob(
  audioData: Buffer,
  format: string,
  opts: { apiKey: string; model?: string | undefined; baseUrl?: string | undefined },
): Promise<string> {
  const model = opts.model ?? 'gpt-4o-mini-transcribe';
  const baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1';

  const formData = new FormData();
  const blob = new Blob([new Uint8Array(audioData)], { type: `audio/${format}` });
  formData.append('file', blob, `audio.${format}`);
  formData.append('model', model);

  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`Transcription API error ${response.status}: ${text}`);
  }

  const result = (await response.json()) as { text?: string };
  return result.text ?? '';
}
