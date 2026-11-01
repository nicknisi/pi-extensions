/**
 * Handoff extension - transfer context to a new focused session
 *
 * Instead of compacting (which is lossy), handoff extracts what matters
 * for your next task and creates a new session with a generated prompt.
 * Includes links to previous sessions for full context recovery.
 *
 * Usage:
 *   /handoff now implement this for teams as well
 *   /handoff execute phase one of the plan
 *   /handoff check other places that need this fix
 *
 * The generated prompt appears as a draft in the editor for review/editing.
 */

import type { Message } from '@earendil-works/pi-ai';
import type { ExtensionAPI, SessionEntry } from '@earendil-works/pi-coding-agent';
import { BorderedLoader, convertToLlm, serializeConversation } from '@earendil-works/pi-coding-agent';

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

/** Share of the model's context window the serialized conversation may use; the rest covers the prompt and output. */
const CONVERSATION_SHARE = 0.7;
const RECENT_REQUESTS = 5;
const REQUEST_MAX_CHARS = 2000;

/** Serialize newest-first until the char budget is spent, so long sessions can't overflow the model. */
export function fitConversation(messages: Message[], maxChars: number): string {
  const kept: string[] = [];
  let used = 0;
  for (const [i, message] of [...messages.entries()].reverse()) {
    const text = serializeConversation([message]);
    if (!text) continue;
    if (used + text.length > maxChars) {
      return [`[${i + 1} earlier messages omitted to fit the context window]`, ...kept.reverse()].join('\n\n');
    }
    kept.push(text);
    used += text.length + 2;
  }
  return kept.reverse().join('\n\n');
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: 'text'; text: string } => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

/** The user's last few messages, verbatim, so constraints survive the model's summary. */
export function recentRequests(messages: readonly { role: string; content?: unknown }[]): string[] {
  return messages
    .filter((m) => m.role === 'user')
    .map((m) => textOf(m.content).trim())
    .filter((text) => text !== '')
    .slice(-RECENT_REQUESTS)
    .map((text) => (text.length > REQUEST_MAX_CHARS ? `${text.slice(0, REQUEST_MAX_CHARS)}… [truncated]` : text));
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand('handoff', {
    description: 'Transfer context to a new focused session',
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify('handoff requires interactive mode', 'error');
        return;
      }

      if (!ctx.model) {
        ctx.ui.notify('No model selected', 'error');
        return;
      }

      const goal = args.trim();
      if (!goal) {
        ctx.ui.notify('Usage: /handoff <goal for new thread>', 'error');
        return;
      }

      // Gather conversation context from current branch
      const branch = ctx.sessionManager.getBranch();
      const messages = branch
        .filter((entry): entry is SessionEntry & { type: 'message' } => entry.type === 'message')
        .map((entry) => entry.message);

      if (messages.length === 0) {
        ctx.ui.notify('No conversation to hand off', 'error');
        return;
      }

      // Convert to LLM format and serialize
      const llmMessages = convertToLlm(messages);
      const conversationText = fitConversation(
        llmMessages,
        Math.floor((ctx.model.contextWindow || 128_000) * CONVERSATION_SHARE) * 4,
      );
      const currentSessionFile = ctx.sessionManager.getSessionFile();

      // Build the chain of parent sessions
      const sessionChain: string[] = currentSessionFile ? [currentSessionFile] : [];
      const header = ctx.sessionManager.getHeader();
      let parentSession = header?.parentSession;
      while (parentSession) {
        sessionChain.push(parentSession);
        // Try to read parent's header to find its parent
        try {
          const { stdout } = await pi.exec('head', ['-1', parentSession]);
          const parentHeader = JSON.parse(stdout);
          parentSession = parentHeader.parentSession;
        } catch {
          break;
        }
      }

      // Generate the handoff prompt with loader UI
      const result = await ctx.ui.custom<{ text: string | null; error?: string }>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(tui, theme, `Generating handoff prompt...`);
        loader.onAbort = () => done({ text: null });

        const doGenerate = async () => {
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
          if (!auth.ok) {
            return {
              text: null,
              error: `No API key for ${ctx.model!.provider}/${ctx.model!.id}: ${auth.error}`,
            };
          }

          const userMessage: Message = {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
              },
            ],
            timestamp: Date.now(),
          };

          const response = await ctx.modelRegistry.complete(
            ctx.model!,
            { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
            { signal: loader.signal },
          );

          if (response.stopReason === 'aborted') {
            return { text: null };
          }

          if (response.stopReason === 'error') {
            return { text: null, error: response.errorMessage || 'Unknown error' };
          }

          const textContent = response.content
            .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
            .map((c) => c.text)
            .join('\n');

          if (!textContent) {
            return {
              text: null,
              error: `No text in response. Stop reason: ${response.stopReason}, content types: ${response.content.map((c) => c.type).join(', ')}`,
            };
          }

          return { text: textContent };
        };

        doGenerate()
          .then(done)
          .catch((err) => {
            done({ text: null, error: err.message || String(err) });
          });

        return loader;
      });

      if (result.error) {
        ctx.ui.notify(`Handoff failed: ${result.error}`, 'error');
        return;
      }

      if (result.text === null) {
        ctx.ui.notify('Cancelled', 'info');
        return;
      }

      const requests = recentRequests(messages);
      const requestsSection =
        requests.length > 0
          ? `\n\n## My Recent Requests (verbatim)\n${requests.map((r) => `> ${r.replace(/\n/g, '\n> ')}`).join('\n\n')}`
          : '';
      const verifySection =
        '\n\nThis handoff was written from the earlier conversation and may be out of date. Check git status and the relevant files before acting on it.';
      const historySection =
        sessionChain.length > 0
          ? `\n\n## Session History\nPrevious session logs (JSONL, most recent first). Search them with rg or grep when you need exact details:\n${sessionChain.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
          : '';

      const promptWithHistory = result.text + requestsSection + verifySection + historySection;

      // Let user edit the generated prompt
      const editedPrompt = await ctx.ui.editor('Edit handoff prompt', promptWithHistory);

      if (editedPrompt === undefined) {
        ctx.ui.notify('Cancelled', 'info');
        return;
      }

      // Create new session with parent tracking. The old ctx is stale once the
      // session is replaced, so the draft goes in through the new session's ctx.
      const newSessionResult = await ctx.newSession({
        ...(currentSessionFile !== undefined && { parentSession: currentSessionFile }),
        withSession: async (newCtx) => {
          newCtx.ui.setEditorText(editedPrompt);
          newCtx.ui.notify('Handoff ready. Submit when ready.', 'info');
        },
      });

      if (newSessionResult.cancelled) {
        ctx.ui.notify('New session cancelled', 'info');
      }
    },
  });
}
