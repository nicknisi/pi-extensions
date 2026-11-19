import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

function textContent(content: unknown): string {
  if (!Array.isArray(content)) return '';

  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'text' &&
        'text' in block &&
        typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('\n\n');
}

export default function saveMarkdownExtension(pi: ExtensionAPI) {
  pi.registerCommand('save-md', {
    description: 'Save the latest assistant response as Markdown (usage: /save-md name)',
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      const branch = ctx.sessionManager.getBranch();
      let foundAssistant = false;
      let markdown = '';
      // Walk back to the most recent assistant message that has text, so a trailing
      // aborted/errored/tool-call-only turn doesn't hide an earlier answer.
      for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index];
        if (entry?.type === 'message' && entry.message.role === 'assistant') {
          foundAssistant = true;
          const text = textContent((entry.message satisfies AssistantMessage).content);
          if (text.trim()) {
            markdown = text;
            break;
          }
        }
      }
      if (!foundAssistant) {
        ctx.ui.notify('No assistant response to save', 'warning');
        return;
      }

      const name = args.trim();
      if (!name) {
        ctx.ui.notify('Usage: /save-md name', 'warning');
        return;
      }

      if (!markdown) {
        ctx.ui.notify('No assistant response on this branch has Markdown text', 'warning');
        return;
      }

      const fileName = name.endsWith('.md') ? name : `${name}.md`;
      const path = resolve(ctx.cwd, fileName);

      try {
        await writeFile(path, markdown.endsWith('\n') ? markdown : `${markdown}\n`, {
          encoding: 'utf8',
          flag: 'wx',
        });
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
          ctx.ui.notify(`File already exists: ${path}`, 'error');
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to save ${path}: ${message}`, 'error');
        return;
      }

      ctx.ui.notify(`Saved Markdown to ${path}`, 'info');
    },
  });
}
