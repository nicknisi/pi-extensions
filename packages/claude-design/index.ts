import { spawn } from 'node:child_process';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { completeLogin, logout, startLogin, statusText } from './auth.js';

function openBrowser(url: string): void {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
}

export default function claudeDesignExtension(pi: ExtensionAPI) {
  pi.registerCommand('design-login', {
    description: 'Authorize Claude Design MCP access (opens browser, paste CODE#STATE back)',
    handler: async (_args, ctx) => {
      const start = startLogin();
      openBrowser(start.url);
      const pasted = await ctx.ui.input(
        'Approve Claude Design access in the browser, then paste the CODE#STATE value:',
        'CODE#STATE',
      );
      if (!pasted?.trim()) {
        ctx.ui.notify('Login cancelled', 'warning');
        return;
      }
      try {
        await completeLogin(start, pasted);
        ctx.ui.notify(
          'Claude Design authorized — the claude-design MCP server will pick it up on next connect',
          'info',
        );
      } catch (error) {
        ctx.ui.notify(`Login failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    },
  });

  pi.registerCommand('design-status', {
    description: 'Show Claude Design credential status',
    handler: async (_args, ctx) => {
      ctx.ui.notify(await statusText(), 'info');
    },
  });

  pi.registerCommand('design-logout', {
    description: 'Delete stored Claude Design credentials',
    handler: async (_args, ctx) => {
      await logout();
      ctx.ui.notify('Claude Design credentials removed', 'info');
    },
  });
}
