/** Whiteboard extension — voice-driven Mermaid diagram generation integrated with the pi session. */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Model, Api } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { spawn } from 'node:child_process';

import {
  startWhiteboardServer,
  stopWhiteboardServer,
  isWhiteboardRunning,
  getCurrentMermaid,
  pushMermaid,
  type ServerCallbacks,
} from './server.js';
import { MERMAID_SYSTEM_PROMPT, stripMermaidFences, buildGenerationMessages, shouldRouteToAgent } from './generate.js';

const ENTRY_TYPE = 'whiteboard';

/** Open a URL in the default browser (cross-platform). */
function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' })
    .on('error', () => {})
    .unref();
}

/** Extract text from an AssistantMessage content array. */
function extractAssistantText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('');
}

interface CapturedContext {
  modelRegistry: ExtensionContext['modelRegistry'];
  sessionManager: ExtensionContext['sessionManager'];
  model: Model<Api> | undefined;
}

let capturedCtx: CapturedContext | null = null;
let piRef: ExtensionAPI | null = null;

/** Build the ServerCallbacks from the captured session context. */
function buildCallbacks(ctx: ExtensionContext): ServerCallbacks {
  // Capture for use outside event handlers
  capturedCtx = {
    modelRegistry: ctx.modelRegistry,
    sessionManager: ctx.sessionManager,
    model: ctx.model,
  };

  return {
    transcriptionApiKey: '', // set below after auth resolution
    transcriptionBaseUrl: 'https://api.openai.com/v1',

    async generate(prompt: string, currentMermaid: string | null): Promise<string> {
      if (!capturedCtx?.model) {
        throw new Error('No active model available for diagram generation');
      }

      const messages = buildGenerationMessages(capturedCtx.sessionManager, currentMermaid, prompt);

      const result = await capturedCtx.modelRegistry.complete(
        capturedCtx.model,
        {
          systemPrompt: MERMAID_SYSTEM_PROMPT,
          messages,
        },
        { reasoningEffort: 'low' },
      );

      const text = extractAssistantText(result.content);
      return stripMermaidFences(text);
    },

    onDiagramGenerated(mermaid: string, prompt: string): void {
      // Inject into session as a custom message (participates in LLM context)
      // Use nextTurn so it's available when the user types their next prompt,
      // but doesn't trigger the agent on its own.
      piRef?.sendMessage(
        {
          customType: ENTRY_TYPE,
          content: `Whiteboard update: "${prompt}"\n\n\`\`\`mermaid\n${mermaid}\n\`\`\``,
          display: true,
        },
        { deliverAs: 'nextTurn' },
      );

      // Persist for session restore
      piRef?.appendEntry(ENTRY_TYPE, { mermaid, prompt, ts: Date.now() });
    },

    shouldRouteToAgent,

    routeToAgent(transcript: string): void {
      // Send as a user message — triggers the agent with full context
      piRef?.sendUserMessage(transcript, { deliverAs: 'followUp' });
    },
  };
}

export default function whiteboard(pi: ExtensionAPI) {
  piRef = pi;

  pi.on('session_shutdown', () => {
    stopWhiteboardServer();
    capturedCtx = null;
  });

  // ─── Restore whiteboard state on session start ───────────────────────────
  pi.on('session_start', async (_event, ctx) => {
    // Look for the latest persisted whiteboard entry
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      if (entry.type === 'custom' && entry.customType === ENTRY_TYPE) {
        const data = entry.data as { mermaid?: string } | undefined;
        if (data?.mermaid) {
          // If the server is running, push the restored diagram
          if (isWhiteboardRunning()) {
            pushMermaid(data.mermaid);
          }
        }
        break;
      }
    }
  });

  // ─── Inject current whiteboard into agent context ────────────────────────
  // When the user types a prompt, inject the current diagram so the agent
  // has it in context. display: false keeps it out of the TUI transcript.
  pi.on('before_agent_start', async (_event, _ctx) => {
    const mermaid = getCurrentMermaid();
    if (!mermaid) return;

    return {
      message: {
        customType: `${ENTRY_TYPE}-context`,
        content: `Current whiteboard diagram:\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n\nThe user has been iterating on this diagram via voice/text. Use it as context for their next request.`,
        display: false,
      },
    };
  });

  // ─── /whiteboard command — opens the browser UI ──────────────────────────
  pi.registerCommand('whiteboard', {
    description: 'Open the voice-driven whiteboard (Mermaid diagram generator in the browser)',
    handler: async (_args, ctx) => {
      if (ctx.mode !== 'tui' && ctx.mode !== 'rpc') {
        if (ctx.hasUI) ctx.ui.notify('Whiteboard requires an interactive session', 'error');
        return;
      }

      // Resolve OpenAI auth for transcription
      const openaiAuth = await ctx.modelRegistry.getProviderAuth('openai');
      const transcriptionApiKey = openaiAuth?.auth.apiKey;
      if (!transcriptionApiKey) {
        if (ctx.hasUI) ctx.ui.notify('Whiteboard requires an OpenAI API key for transcription', 'error');
        return;
      }

      const callbacks = buildCallbacks(ctx);
      callbacks.transcriptionApiKey = transcriptionApiKey;
      callbacks.transcriptionBaseUrl = openaiAuth?.auth.baseUrl ?? 'https://api.openai.com/v1';

      const url = await startWhiteboardServer(callbacks);
      openInBrowser(url);
      if (ctx.hasUI) ctx.ui.notify(`Whiteboard: ${url}`, 'info');
    },
  });

  // ─── whiteboard tool — agent can open, update, snapshot, or check status ──
  pi.registerTool({
    name: 'whiteboard',
    label: 'Whiteboard',
    description:
      'Voice-driven whiteboard that renders Mermaid diagrams in real-time in the browser and integrates with the pi session. ' +
      'The user can type or speak descriptions and the diagram updates live using the active model with session context. ' +
      'Actions: "open" to launch the whiteboard, "update" to push a Mermaid diagram to the whiteboard (requires content), ' +
      '"snapshot" to read the current diagram back, "status" to check if it is running. ' +
      'Use "update" when you want to show the user a diagram based on codebase analysis. ' +
      'Use "snapshot" when you need to reference what the user has drawn.',
    promptSnippet: 'Open or interact with the voice-driven whiteboard (Mermaid diagrams)',
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union([Type.Literal('open'), Type.Literal('update'), Type.Literal('snapshot'), Type.Literal('status')], {
          description:
            'Action: "open" (default) to launch, "update" to push Mermaid, "snapshot" to read current, "status" to check.',
        }),
      ),
      content: Type.Optional(
        Type.String({
          description:
            'Mermaid diagram code for action "update". The diagram is pushed to the browser and injected into session context.',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action ?? 'open';

      // ── status ──────────────────────────────────────────────────────────
      if (action === 'status') {
        const running = isWhiteboardRunning();
        const mermaid = getCurrentMermaid();
        return {
          content: [
            {
              type: 'text' as const,
              text: running
                ? `Whiteboard is running${mermaid ? ` with a current diagram (${mermaid.length} chars)` : ''}`
                : 'Whiteboard is not running',
            },
          ],
          details: { running, hasDiagram: mermaid !== null },
        };
      }

      // ── snapshot ────────────────────────────────────────────────────────
      if (action === 'snapshot') {
        const mermaid = getCurrentMermaid();
        if (!mermaid) {
          return {
            content: [{ type: 'text' as const, text: 'No diagram on the whiteboard yet.' }],
            details: {},
          };
        }
        return {
          content: [{ type: 'text' as const, text: `Current whiteboard diagram:\n\`\`\`mermaid\n${mermaid}\n\`\`\`` }],
          details: { mermaid },
        };
      }

      // ── update (agent pushes a diagram) ──────────────────────────────────
      if (action === 'update') {
        const content = params.content?.trim();
        if (!content) {
          return {
            content: [
              { type: 'text' as const, text: 'Error: `content` (Mermaid code) is required for action "update"' },
            ],
            isError: true,
            details: {},
          };
        }

        // Start the server if not running (need auth for future voice input)
        if (!isWhiteboardRunning()) {
          const openaiAuth = await ctx.modelRegistry.getProviderAuth('openai');
          if (!openaiAuth?.auth.apiKey) {
            return {
              content: [{ type: 'text' as const, text: 'Error: OpenAI API key required for whiteboard' }],
              isError: true,
              details: {},
            };
          }
          const callbacks = buildCallbacks(ctx);
          callbacks.transcriptionApiKey = openaiAuth.auth.apiKey;
          callbacks.transcriptionBaseUrl = openaiAuth.auth.baseUrl ?? 'https://api.openai.com/v1';
          await startWhiteboardServer(callbacks);
        }

        pushMermaid(content);

        // Inject into session so the agent's context includes the pushed diagram
        pi.sendMessage(
          {
            customType: ENTRY_TYPE,
            content: `Agent pushed diagram to whiteboard:\n\`\`\`mermaid\n${content}\n\`\`\``,
            display: true,
          },
          { deliverAs: 'nextTurn' },
        );

        pi.appendEntry(ENTRY_TYPE, { mermaid: content, prompt: 'agent', ts: Date.now() });

        return {
          content: [{ type: 'text' as const, text: 'Diagram pushed to whiteboard.' }],
          details: { action: 'update', chars: content.length },
        };
      }

      // ── open ─────────────────────────────────────────────────────────────
      const openaiAuth = await ctx.modelRegistry.getProviderAuth('openai');
      if (!openaiAuth?.auth.apiKey) {
        return {
          content: [{ type: 'text' as const, text: 'Error: OpenAI API key required for whiteboard' }],
          isError: true,
          details: {},
        };
      }

      const callbacks = buildCallbacks(ctx);
      callbacks.transcriptionApiKey = openaiAuth.auth.apiKey;
      callbacks.transcriptionBaseUrl = openaiAuth.auth.baseUrl ?? 'https://api.openai.com/v1';

      const url = await startWhiteboardServer(callbacks);
      openInBrowser(url);

      return {
        content: [{ type: 'text' as const, text: `Whiteboard opened at ${url}` }],
        details: { url },
      };
    },
  });
}
