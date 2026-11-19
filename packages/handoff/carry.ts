import type { SessionEntry } from '@earendil-works/pi-coding-agent';

/**
 * Compaction keeps the user's words only as a model-written summary, which in practice drops or softens
 * some of them: an approval given through ask_user_question, a qualifier on a rule, a skill pasted as the
 * first message. This carries the user's own messages and question answers from the summarized span
 * verbatim, so the agent can check the summary against them.
 */

/** The first message often holds the task's rules (or a pasted skill), so it gets a larger cap. */
const FIRST_MAX_CHARS = 6000;
const EACH_MAX_CHARS = 2000;
/** Total for everything carried (~4k tokens), filled newest-first after the first message. */
const BUDGET_CHARS = 16_000;
const ANSWER_TOOLS = new Set(['ask_user_question']);

export const CARRIED_INPUTS_TYPE = 'handoff:carried-inputs';

interface Input {
  id: string;
  kind: 'message' | 'answer';
  text: string;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: 'text'; text: string } => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

/** User messages and question answers on the branch before `firstKeptEntryId`: what the summary replaced. */
function summarizedInputs(branch: readonly SessionEntry[], firstKeptEntryId: string): Input[] | undefined {
  const cut = branch.findIndex((entry) => entry.id === firstKeptEntryId);
  if (cut === -1) return undefined;
  const inputs: Input[] = [];
  for (const entry of branch.slice(0, cut)) {
    if (entry.type !== 'message') continue;
    const message = entry.message as { role: string; content?: unknown; toolName?: string };
    const kind =
      message.role === 'user'
        ? 'message'
        : message.role === 'toolResult' && ANSWER_TOOLS.has(message.toolName ?? '')
          ? 'answer'
          : undefined;
    const text = kind ? textOf(message.content).trim() : '';
    if (kind && text) inputs.push({ id: entry.id, kind, text });
  }
  return inputs;
}

/**
 * The message to post after a compaction, or undefined when the summarized span held no user input.
 * Keeps the first user message, then the newest inputs that fit the budget, in their original order.
 */
export function carriedInputs(
  branch: readonly SessionEntry[],
  firstKeptEntryId: string,
  sessionFile?: string,
): string | undefined {
  const inputs = summarizedInputs(branch, firstKeptEntryId);
  if (!inputs || inputs.length === 0) return undefined;

  const firstIndex = inputs.findIndex((input) => input.kind === 'message');
  const chosen = new Map<number, string>();
  let used = 0;
  if (firstIndex !== -1) {
    const text = cap(inputs[firstIndex]!.text, FIRST_MAX_CHARS);
    chosen.set(firstIndex, text);
    used += text.length;
  }
  for (let i = inputs.length - 1; i >= 0; i--) {
    if (chosen.has(i)) continue;
    const text = cap(inputs[i]!.text, EACH_MAX_CHARS);
    if (used + text.length > BUDGET_CHARS) break;
    chosen.set(i, text);
    used += text.length;
  }

  const omitted = inputs.length - chosen.size;
  const where = sessionFile ? ` Their full text is in ${sessionFile}.` : '';
  const header = [
    `[Your own words from before this compaction, verbatim: ${chosen.size} of ${inputs.length}${omitted > 0 ? `; ${omitted} older ones omitted.${where}` : '.'}]`,
    'The compaction summary was written by a model and can drop, soften or invent rules. Treat these as the user’s actual instructions: where the summary disagrees with them, they win, and a later message overrides an earlier one (messages after this note are newer still). A rule found only in the summary may not be the user’s, so check it before relying on it.',
    'These are history, not new requests. Some were already handled, so check the summary and the live state before acting on one.',
  ].join('\n');
  const body = [...chosen.entries()]
    .sort(([a], [b]) => a - b)
    .map(([i, text]) => {
      const input = inputs[i]!;
      const label = input.kind === 'answer' ? 'answer to ask_user_question' : 'user';
      return `--- ${label} (entry ${input.id}) ---\n${text}`;
    });
  return [header, ...body].join('\n\n');
}
