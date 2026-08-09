/** Whiteboard extension — voice-driven Mermaid diagrams rendered inline in the TUI session. */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { matchesKey, Key, type Component, type TUI } from '@earendil-works/pi-tui';
import { type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

import { RealtimeTranscriber, transcribeBlob } from './transcription.js';
import { startRecording, stopRecording, checkAudioTool } from './audio.js';
import { MERMAID_SYSTEM_PROMPT, stripMermaidFences, buildGenerationMessages, shouldRouteToAgent } from './generate.js';

const ENTRY_TYPE = 'whiteboard';

let piRef: ExtensionAPI | null = null;
let currentMermaid: string | null = null;
let generatingController: AbortController | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract text from an AssistantMessage content array. */
function extractAssistantText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('');
}

/** Generate Mermaid from a prompt using the active model + session context. */
async function generateMermaid(ctx: ExtensionContext, prompt: string): Promise<string> {
  const model = ctx.model;
  if (!model) throw new Error('No active model available for diagram generation');

  const messages = buildGenerationMessages(ctx.sessionManager, currentMermaid, prompt);

  const result = await ctx.modelRegistry.complete(
    model,
    { systemPrompt: MERMAID_SYSTEM_PROMPT, messages },
    { reasoningEffort: 'low' },
  );

  return stripMermaidFences(extractAssistantText(result.content));
}

/** Inject a Mermaid diagram into the session (pi renders it inline via mermaid transformer). */
function injectDiagram(mermaid: string, prompt: string): void {
  currentMermaid = mermaid;

  // sendMessage with display: true → pi renders the mermaid block in the TUI
  // and the message participates in LLM context
  piRef?.sendMessage(
    {
      customType: ENTRY_TYPE,
      content: `**Whiteboard:** ${prompt}\n\n\`\`\`mermaid\n${mermaid}\n\`\`\``,
      display: true,
    },
    { deliverAs: 'nextTurn' },
  );

  // Persist for session restore
  piRef?.appendEntry(ENTRY_TYPE, { mermaid, prompt, ts: Date.now() });
}

/** Route a transcript to the agent as a user message. */
function routeToAgent(transcript: string): void {
  piRef?.sendUserMessage(transcript, { deliverAs: 'followUp' });
}

/** Resolve OpenAI API key + base URL from the model registry. */
async function resolveOpenAiAuth(ctx: ExtensionContext): Promise<{ apiKey: string; baseUrl: string } | null> {
  const result = await ctx.modelRegistry.getProviderAuth('openai');
  const apiKey = result?.auth.apiKey;
  if (!apiKey) return null;
  return { apiKey, baseUrl: result.auth.baseUrl ?? 'https://api.openai.com/v1' };
}

// ─── TUI Overlay Component ────────────────────────────────────────────────────

interface OverlayState {
  status: 'idle' | 'listening' | 'transcribing' | 'generating' | 'routing' | 'error';
  transcript: string;
  partial: string;
  errorMsg: string;
}

type ThemeLike = {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
};

type OverlayAction = 'talk' | 'continuous' | 'text' | 'clear';

class WhiteboardOverlay implements Component {
  private state: OverlayState;
  private tui: TUI | null = null;
  private readonly theme: ThemeLike;

  constructor(
    private readonly onAction: (action: OverlayAction) => void,
    theme: ThemeLike,
  ) {
    this.state = { status: 'idle', transcript: '', partial: '', errorMsg: '' };
    this.theme = theme;
  }

  setTui(tui: TUI): void {
    this.tui = tui;
  }

  setState(updates: Partial<OverlayState>): void {
    this.state = { ...this.state, ...updates };
    this.tui?.requestRender();
  }

  render(_width: number): string[] {
    const lines: string[] = [];
    const t = this.theme;

    lines.push(t.bold('📋 Whiteboard'));
    lines.push('');

    const statusLabels: Record<OverlayState['status'], string> = {
      idle: t.fg('dim', '● Ready'),
      listening: t.fg('accent', '◉ Listening...'),
      transcribing: t.fg('accent', '◌ Transcribing...'),
      generating: t.fg('accent', '✦ Generating diagram...'),
      routing: t.fg('accent', '→ Routing to agent...'),
      error: t.fg('error', '✗ Error'),
    };
    lines.push(statusLabels[this.state.status]);

    if (this.state.errorMsg) {
      lines.push(t.fg('error', `  ${this.state.errorMsg}`));
    }

    lines.push('');

    if (this.state.partial) {
      lines.push(t.fg('dim', `  ${this.state.partial}...`));
    }
    if (this.state.transcript) {
      lines.push(`  "${this.state.transcript}"`);
    }

    lines.push('');

    if (currentMermaid) {
      lines.push(t.fg('dim', `  Current diagram: ${currentMermaid.length} chars`));
    } else {
      lines.push(t.fg('dim', '  No diagram yet'));
    }

    lines.push('');
    lines.push(t.fg('dim', '  [space] push to talk  [c] continuous  [t] text  [x] clear  [q] quit'));

    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c')) || matchesKey(data, 'q')) {
      this.onAction('quit' as OverlayAction);
    } else if (matchesKey(data, Key.space)) {
      this.onAction('talk');
    } else if (matchesKey(data, 'c')) {
      this.onAction('continuous');
    } else if (matchesKey(data, 't')) {
      this.onAction('text');
    } else if (matchesKey(data, 'x')) {
      this.onAction('clear');
    }
  }

  invalidate(): void {
    // No cached state to invalidate
  }
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function whiteboard(pi: ExtensionAPI) {
  piRef = pi;

  pi.on('session_shutdown', () => {
    piRef = null;
    currentMermaid = null;
  });

  // ─── Restore whiteboard state on session start ───────────────────────────
  pi.on('session_start', async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      if (entry.type === 'custom' && entry.customType === ENTRY_TYPE) {
        const data = entry.data as { mermaid?: string } | undefined;
        if (data?.mermaid) {
          currentMermaid = data.mermaid;
        }
        break;
      }
    }
  });

  // ─── Inject current diagram into agent context ───────────────────────────
  pi.on('before_agent_start', async () => {
    if (!currentMermaid) return;
    return {
      message: {
        customType: `${ENTRY_TYPE}-context`,
        content: `Current whiteboard diagram:\n\`\`\`mermaid\n${currentMermaid}\n\`\`\`\n\nThe user has been iterating on this diagram via voice/text. Use it as context.`,
        display: false,
      },
    };
  });

  // ─── /whiteboard command — opens TUI overlay ─────────────────────────────
  pi.registerCommand('whiteboard', {
    description: 'Open the voice-driven whiteboard (Mermaid diagrams rendered in the terminal)',
    handler: async (_args, ctx) => {
      if (ctx.mode !== 'tui') {
        if (ctx.hasUI) ctx.ui.notify('Whiteboard requires interactive TUI mode', 'error');
        return;
      }

      const auth = await resolveOpenAiAuth(ctx);
      if (!auth) {
        if (ctx.hasUI) ctx.ui.notify('Whiteboard requires an OpenAI API key for transcription', 'error');
        return;
      }

      const audioTool = await checkAudioTool();
      if (!audioTool) {
        if (ctx.hasUI)
          ctx.ui.notify('Whiteboard requires ffmpeg (macOS) or arecord (Linux) for audio capture', 'error');
        return;
      }

      // State for this overlay session
      let recordingProc: ChildProcessByStdio<null, Readable, Readable> | null = null;
      let audioChunks: Buffer[] = [];
      let transcriber: RealtimeTranscriber | null = null;
      let isContinuous = false;
      let overlay: WhiteboardOverlay | null = null;

      const generate = async (prompt: string) => {
        if (!prompt.trim()) return;

        if (generatingController) generatingController.abort();
        generatingController = new AbortController();

        overlay?.setState({ status: 'generating', errorMsg: '' });

        try {
          const mermaid = await generateMermaid(ctx, prompt);
          injectDiagram(mermaid, prompt);
          overlay?.setState({ status: 'idle', transcript: prompt, partial: '', errorMsg: '' });
        } catch (err) {
          overlay?.setState({ status: 'error', errorMsg: String(err) });
        } finally {
          generatingController = null;
        }
      };

      const handleTranscript = async (transcript: string) => {
        overlay?.setState({ status: 'transcribing', transcript, partial: '' });

        if (shouldRouteToAgent(transcript)) {
          overlay?.setState({ status: 'routing' });
          routeToAgent(transcript);
          overlay?.setState({ status: 'idle' });
        } else {
          await generate(transcript);
        }
      };

      const startTalk = () => {
        if (recordingProc || isContinuous) return;
        audioChunks = [];
        overlay?.setState({ status: 'listening', partial: '', errorMsg: '' });
        recordingProc = startRecording((chunk: Buffer) => audioChunks.push(chunk));
      };

      const stopTalk = async () => {
        if (!recordingProc) return;
        const proc = recordingProc;
        recordingProc = null;
        const audioData = await stopRecording(proc);

        if (audioData.length === 0) {
          overlay?.setState({ status: 'idle' });
          return;
        }

        overlay?.setState({ status: 'transcribing' });
        try {
          const transcript = await transcribeBlob(audioData, 'raw', {
            apiKey: auth.apiKey,
            baseUrl: auth.baseUrl,
          });
          await handleTranscript(transcript);
        } catch (err) {
          overlay?.setState({ status: 'error', errorMsg: String(err) });
        }
      };

      const toggleContinuous = async () => {
        if (isContinuous) {
          if (transcriber) {
            await transcriber.stop();
            transcriber = null;
          }
          if (recordingProc) {
            recordingProc.kill('SIGINT');
            recordingProc = null;
          }
          isContinuous = false;
          overlay?.setState({ status: 'idle' });
          return;
        }

        isContinuous = true;
        overlay?.setState({ status: 'listening', partial: '', errorMsg: '' });

        transcriber = new RealtimeTranscriber({
          apiKey: auth.apiKey,
          onPartial: (text) => overlay?.setState({ partial: text }),
          onFinal: (text) => {
            overlay?.setState({ transcript: text, partial: '' });
            handleTranscript(text).catch(() => {});
          },
          onError: (err) => overlay?.setState({ status: 'error', errorMsg: String(err) }),
        });

        try {
          await transcriber.connect();
          recordingProc = startRecording((chunk: Buffer) => {
            transcriber?.sendAudio(chunk);
          });
        } catch (err) {
          overlay?.setState({ status: 'error', errorMsg: String(err) });
          isContinuous = false;
        }
      };

      const textInput = async () => {
        const text = await ctx.ui.input('Diagram description:', '');
        if (text) {
          overlay?.setState({ transcript: text });
          await generate(text);
        }
      };

      const clearBoard = () => {
        currentMermaid = null;
        overlay?.setState({ transcript: '', partial: '', status: 'idle' });
      };

      const cleanup = () => {
        if (recordingProc) recordingProc.kill('SIGINT');
        if (transcriber) transcriber.stop().catch(() => {});
      };

      const handleAction = (action: OverlayAction) => {
        if (action === ('quit' as OverlayAction)) {
          cleanup();
          return;
        }
        switch (action) {
          case 'talk':
            if (recordingProc) stopTalk();
            else startTalk();
            break;
          case 'continuous':
            toggleContinuous();
            break;
          case 'text':
            textInput();
            break;
          case 'clear':
            clearBoard();
            break;
        }
      };

      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          overlay = new WhiteboardOverlay(handleAction, {
            fg: (color: string, text: string) => theme.fg(color as never, text),
            bold: (text: string) => theme.bold(text),
          });
          overlay.setTui(tui);

          // Wrap done to ensure cleanup
          const cleanupAndDone = () => {
            cleanup();
            done();
          };

          // Override handleInput to intercept quit
          const origHandleInput = overlay.handleInput.bind(overlay);
          overlay.handleInput = (data: string) => {
            if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c')) || matchesKey(data, 'q')) {
              cleanupAndDone();
            } else {
              origHandleInput(data);
            }
          };

          return overlay;
        },
        { overlay: true },
      );
    },
  });

  // ─── whiteboard tool — agent can update, snapshot, or check status ───────
  pi.registerTool({
    name: 'whiteboard',
    label: 'Whiteboard',
    description:
      'Voice-driven whiteboard that renders Mermaid diagrams inline in the terminal session. ' +
      'The user can type or speak descriptions and the diagram updates live using the active model with session context. ' +
      'Actions: "update" to push a Mermaid diagram (requires content) — renders inline in the session, ' +
      '"snapshot" to read the current diagram back, "status" to check if a diagram exists.',
    promptSnippet: 'Push or read Mermaid diagrams on the whiteboard',
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union([Type.Literal('update'), Type.Literal('snapshot'), Type.Literal('status')], {
          description: 'Action: "update" (default) to push Mermaid, "snapshot" to read current, "status" to check.',
        }),
      ),
      content: Type.Optional(
        Type.String({
          description: 'Mermaid diagram code for action "update". Rendered inline in the session.',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const action = params.action ?? 'update';

      if (action === 'status') {
        return {
          content: [
            {
              type: 'text' as const,
              text: currentMermaid
                ? `Whiteboard has a diagram (${currentMermaid.length} chars)`
                : 'Whiteboard is empty',
            },
          ],
          details: { hasDiagram: currentMermaid !== null },
        };
      }

      if (action === 'snapshot') {
        if (!currentMermaid) {
          return {
            content: [{ type: 'text' as const, text: 'No diagram on the whiteboard.' }],
            details: {},
          };
        }
        return {
          content: [
            { type: 'text' as const, text: `Current whiteboard diagram:\n\`\`\`mermaid\n${currentMermaid}\n\`\`\`` },
          ],
          details: { mermaid: currentMermaid },
        };
      }

      // action === 'update'
      const content = params.content?.trim();
      if (!content) {
        return {
          content: [{ type: 'text' as const, text: 'Error: `content` (Mermaid code) is required for action "update"' }],
          isError: true,
          details: {},
        };
      }

      injectDiagram(content, 'agent');

      return {
        content: [{ type: 'text' as const, text: 'Diagram pushed to whiteboard and rendered in session.' }],
        details: { action: 'update', chars: content.length },
      };
    },
  });
}
