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

import { open } from 'node:fs/promises';
import type { Message } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from '@earendil-works/pi-coding-agent';
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

const TRUNCATED = '… [truncated]';
const MAX_CHAIN_DEPTH = 20;
const HEADER_READ_BYTES = 64 * 1024;

/** Serialize newest-first until the char budget is spent, so long sessions can't overflow the model. */
export function fitConversation(messages: Message[], maxChars: number): string {
  const kept: string[] = [];
  let used = 0;
  for (const [i, message] of [...messages.entries()].reverse()) {
    const text = serializeConversation([message]);
    if (!text) continue;
    if (used + text.length > maxChars) {
      // A newest message bigger than the whole budget would otherwise leave the model nothing at all.
      let omitted = i + 1;
      if (kept.length === 0) {
        kept.push(`${text.slice(0, Math.max(0, maxChars - TRUNCATED.length))}${TRUNCATED}`);
        omitted = i;
      }
      if (omitted === 0) return kept.reverse().join('\n\n');
      return [`[${omitted} earlier messages omitted to fit the context window]`, ...kept.reverse()].join('\n\n');
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
    .map((text) => (text.length > REQUEST_MAX_CHARS ? `${text.slice(0, REQUEST_MAX_CHARS)}${TRUNCATED}` : text));
}

type ContextMessage = Parameters<typeof convertToLlm>[0][number];

/**
 * Turn branch entries into the messages the agent saw: plain messages plus
 * compaction summaries, /tree branch summaries and extension custom messages.
 */
export function entriesToMessages(entries: readonly SessionEntry[]): ContextMessage[] {
  return entries.flatMap((entry): ContextMessage[] => {
    const timestamp = new Date(entry.timestamp).getTime();
    switch (entry.type) {
      case 'message':
        return [entry.message];
      case 'compaction':
        return [{ role: 'compactionSummary', summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp }];
      case 'branch_summary':
        return entry.summary
          ? [{ role: 'branchSummary', summary: entry.summary, fromId: entry.fromId, timestamp }]
          : [];
      case 'custom_message':
        return [
          {
            role: 'custom',
            customType: entry.customType,
            content: entry.content ?? [],
            display: entry.display,
            details: entry.details,
            timestamp,
          },
        ];
      default:
        return [];
    }
  });
}

/** Read and parse the JSONL header (first line) of a session file, or undefined if unreadable. */
async function readSessionHeader(file: string): Promise<{ parentSession?: unknown } | undefined> {
  try {
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(HEADER_READ_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEADER_READ_BYTES, 0);
      const firstLine = buffer.toString('utf8', 0, bytesRead).split('\n', 1)[0] ?? '';
      const header: unknown = JSON.parse(firstLine);
      return header && typeof header === 'object' ? header : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** The current session followed by its ancestors, stopping at unreadable files, cycles, or MAX_CHAIN_DEPTH. */
export async function buildSessionChain(
  currentFile: string | undefined,
  parent: string | undefined,
): Promise<string[]> {
  const chain: string[] = currentFile ? [currentFile] : [];
  const seen = new Set(chain);
  let next = parent;
  while (next && !seen.has(next) && chain.length < MAX_CHAIN_DEPTH) {
    chain.push(next);
    seen.add(next);
    const header = await readSessionHeader(next);
    next = typeof header?.parentSession === 'string' ? header.parentSession : undefined;
  }
  return chain;
}

type GenerateResult = { text: string | null; error?: string };

async function generatePrompt(
  ctx: ExtensionCommandContext,
  conversationText: string,
  goal: string,
  signal: AbortSignal | undefined,
): Promise<GenerateResult> {
  const model = ctx.model!;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    return { text: null, error: `No API key for ${model.provider}/${model.id}: ${auth.error}` };
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
    model,
    { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
    { signal },
  );

  if (response.stopReason === 'aborted') return { text: null };
  if (response.stopReason === 'error') return { text: null, error: response.errorMessage || 'Unknown error' };

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
}

const toError = (err: unknown): GenerateResult => ({
  text: null,
  error: (err instanceof Error && err.message) || String(err),
});

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

      // Gather what the agent saw on the current branch, including summaries and custom messages
      const branch = ctx.sessionManager.getBranch();
      const messages = entriesToMessages(branch);

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
      const sessionChain = await buildSessionChain(currentSessionFile, ctx.sessionManager.getHeader()?.parentSession);

      // Generate the handoff prompt: abortable loader in the TUI; RPC has no custom components, so run it directly.
      let result: GenerateResult | undefined;
      if (ctx.mode === 'tui') {
        result = await ctx.ui.custom<GenerateResult>((tui, theme, _kb, done) => {
          const loader = new BorderedLoader(tui, theme, `Generating handoff prompt...`);
          loader.onAbort = () => done({ text: null });
          generatePrompt(ctx, conversationText, goal, loader.signal)
            .then(done)
            .catch((err) => done(toError(err)));
          return loader;
        });
      } else {
        ctx.ui.notify('Generating handoff prompt...', 'info');
        result = await generatePrompt(ctx, conversationText, goal, undefined).catch(toError);
      }
      result ??= { text: null };

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
