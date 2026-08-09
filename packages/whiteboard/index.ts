/** Whiteboard extension — voice-driven Mermaid diagram generation in the browser. */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { spawn } from 'node:child_process';

import { startWhiteboardServer, stopWhiteboardServer, isWhiteboardRunning } from './server.js';

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

/** Resolve the OpenAI API key and base URL from the model registry. */
async function resolveOpenAiAuth(modelRegistry: {
  getProviderAuth: (id: string) => Promise<{ auth: { apiKey?: string; baseUrl?: string } } | undefined>;
}): Promise<{ apiKey: string; baseUrl: string } | null> {
  const result = await modelRegistry.getProviderAuth('openai');
  const apiKey = result?.auth.apiKey;
  if (!apiKey) return null;
  return { apiKey, baseUrl: result.auth.baseUrl ?? 'https://api.openai.com/v1' };
}

export default function whiteboard(pi: ExtensionAPI) {
  pi.on('session_shutdown', () => {
    stopWhiteboardServer();
  });

  // ─── /whiteboard command — opens the browser UI ──────────────────────────
  pi.registerCommand('whiteboard', {
    description: 'Open the voice-driven whiteboard (Mermaid diagram generator in the browser)',
    handler: async (_args, ctx) => {
      const auth = await resolveOpenAiAuth(ctx.modelRegistry);
      if (!auth) {
        if (ctx.hasUI) ctx.ui.notify('Whiteboard requires an OpenAI API key', 'error');
        return;
      }

      const url = await startWhiteboardServer({
        apiKey: auth.apiKey,
        baseUrl: auth.baseUrl,
      });

      openInBrowser(url);
      if (ctx.hasUI) ctx.ui.notify(`Whiteboard: ${url}`, 'info');
    },
  });

  // ─── whiteboard tool — LLM can open the whiteboard ───────────────────────
  pi.registerTool({
    name: 'whiteboard',
    label: 'Whiteboard',
    description:
      'Open a voice-driven whiteboard that renders Mermaid diagrams in real-time in the browser. ' +
      'The user can type or speak descriptions and the diagram updates live. ' +
      'Use action "open" to launch the whiteboard, or "status" to check if it is running.',
    promptSnippet: 'Open a voice-driven whiteboard with live Mermaid diagram generation',
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union([Type.Literal('open'), Type.Literal('status')], {
          description: 'Action: "open" (default) to launch the whiteboard, "status" to check if running.',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action ?? 'open';

      if (action === 'status') {
        return {
          content: [
            {
              type: 'text' as const,
              text: isWhiteboardRunning() ? 'Whiteboard is running' : 'Whiteboard is not running',
            },
          ],
          details: {},
        };
      }

      // action === 'open'
      const auth = await resolveOpenAiAuth(ctx.modelRegistry);
      if (!auth) {
        return {
          content: [{ type: 'text' as const, text: 'Error: OpenAI API key required for whiteboard' }],
          isError: true,
          details: {},
        };
      }

      const url = await startWhiteboardServer({
        apiKey: auth.apiKey,
        baseUrl: auth.baseUrl,
      });
      openInBrowser(url);

      return {
        content: [{ type: 'text' as const, text: `Whiteboard opened at ${url}` }],
        details: { url },
      };
    },
  });
}
