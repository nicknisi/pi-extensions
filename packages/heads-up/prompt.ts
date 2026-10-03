import type { Note } from './parse.js';

const SYSTEM = `You are a side agent watching this coding session. The main agent keeps working; you never interrupt it and you have no tools. You see the session as a transcript digest: tool calls and results are shortened. Your one job: decide whether the person should see a short note about something with real consequences that they will plausibly miss.

## The bar
Default to "learn: none". Most checks should end there. Suggest something only when all hold:
- It matters to their work, with a cost if they do not understand it (wrong result, money, data, security, a decision they would have made differently).
- They are not already discussing it. If they asked about it, replied to it, or it was the main point of an answer, skip it.
- It is not trivia. Surprising is not the same as important.
A decision the agent made in passing, inside a long answer or the middle of a long task, is the best kind of topic.

## Tags
- Heads up: about this session's work. A decision the agent made, something it did not highlight, a result that may be wrong. Missing it costs them soon.
- You should know: how a system, concept or design works, when understanding it matters for their work.
If neither reads naturally, say learn: none.

## The reader
Busy, switching context constantly, remembers nothing from earlier. Every noun must make sense a week from now with this conversation forgotten. Plain words. Explain any technical term they have not used themselves. Never reuse a name the agent coined unless the person used it too.

## Output
Exactly one of:

learn: none

or

learn: <one or two sentences, about 20 words, ending with a period>
tag: <Heads up or You should know>
explain:
**<title stating the takeaway, plain words, no question>**
<explainer: plain sentences for a simple idea, 3-6 bullets for a complex one, at most 120 words>

## Examples
GOOD learn: The agent added prompt caching to /ask, which makes one-off questions cost about 25% more.
(Names the tradeoff and its cost in plain words.)
BAD learn: Want to learn more about how Trendline works?
(Vague; says nothing about what matters.)
BAD learn: You decided to encrypt the Orders DB at rest.
(Repeats their own choice back; no insight.)
BAD learn: The YAML parser reads "no" as false.
(Interesting, no stake for this work.)
BAD learn: The flag you renamed is read in three places and loaded at startup.
(Routine plumbing after a routine change.)`;

export const checkSystem = SYSTEM;

const session = (digest: string): string => `<session>\n${digest}\n</session>`;

export const checkPrompt = (digest: string, offered: string[], known: string[]): string =>
  [
    session(digest),
    offered.length ? `## Already offered recently; skip these\n${offered.map((o) => `- ${o}`).join('\n')}` : '',
    known.length
      ? `## The person said they already understand these; skip them\n${known.map((k) => `- ${k}`).join('\n')}`
      : '',
    'Answer straight away in the output format from your instructions and nothing else.',
  ]
    .filter(Boolean)
    .join('\n\n');

export type Variant = 'simpler' | 'less' | 'more';

const VARIANTS: Record<Variant, string> = {
  simpler:
    'Same content, said more plainly: shorter sentences, everyday words, no symbols or arrows, no technical terms. At most 100 words.',
  less: 'Only the single most important point: what the thing is in one clause, then the one consequence and the choice. No technical terms. At most 45 words.',
  more: 'Name the real parts: the actual config keys, files or functions involved (each introduced in everyday words first, then the name in backticks), and one edge case that would surprise them. At most 160 words.',
};

const ASKED: Record<Variant, string> = {
  simpler: 'in simpler words',
  less: 'with less detail',
  more: 'in more detail',
};

export const variantSystem =
  'You are a side agent watching a coding session, with no tools. You rewrite a short note you showed the person earlier. You see the session as a transcript digest.';

export const variantPrompt = (digest: string, note: Note, variant: Variant): string =>
  `${session(digest)}

Earlier you showed the person this note:

**${note.title}**
${note.body}

They asked for it again, ${ASKED[variant]}. ${VARIANTS[variant]}
Do not repeat it; rewrite it. Start with a bold title line. Output only the explanation.`;

export const pagePrompt = (note: Note): string =>
  `Write a short learning page on this topic and publish it as an artifact for me: ${note.learn}\n\nContext I was shown:\n**${note.title}**\n${note.body}`;

export const chatPrompt = (note: Note): string => `Explain this to me: ${note.learn}`;

// ── Transcript digest ────────────────────────────────────────────────────

/** Loose shape of the session entries the digest reads; tolerant of pi version drift. */
type Entry = { type: string; summary?: string; message?: Msg };
type Msg = {
  role?: string;
  content?: unknown;
  toolName?: string;
  isError?: boolean;
  command?: string;
  output?: string;
  excludeFromContext?: boolean;
};
type Block = { type?: string; text?: string; name?: string; arguments?: unknown };

const TOOL_ARGS_MAX = 300;
const TOOL_RESULT_MAX = 400;

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more chars]`;

const blocks = (content: unknown): Block[] =>
  typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : Array.isArray(content)
      ? content.filter((b): b is Block => !!b && typeof b === 'object')
      : [];

const text = (content: unknown): string =>
  blocks(content)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();

const section = (entry: Entry): string => {
  if ((entry.type === 'compaction' || entry.type === 'branch_summary') && entry.summary) {
    return `[Summary of earlier work]\n${entry.summary}`;
  }
  if (entry.type !== 'message' || !entry.message) return '';
  const m = entry.message;
  switch (m.role) {
    case 'user': {
      const t = text(m.content);
      return t ? `User: ${t}` : '';
    }
    case 'assistant': {
      const lines: string[] = [];
      const t = text(m.content);
      if (t) lines.push(`Assistant: ${t}`);
      for (const b of blocks(m.content)) {
        if (b.type === 'toolCall' && b.name) {
          lines.push(`Tool call ${b.name}: ${clip(JSON.stringify(b.arguments ?? {}), TOOL_ARGS_MAX)}`);
        }
      }
      return lines.join('\n');
    }
    case 'toolResult': {
      const t = text(m.content);
      return `Tool result${m.toolName ? ` (${m.toolName})` : ''}${m.isError ? ' [error]' : ''}: ${clip(t || '(empty)', TOOL_RESULT_MAX)}`;
    }
    case 'bashExecution':
      return m.excludeFromContext || !m.command
        ? ''
        : `User ran: ${m.command}\n${clip(m.output ?? '', TOOL_RESULT_MAX)}`;
    default:
      return '';
  }
};

/**
 * Serialize the context the main agent sees (compaction applied) into a
 * compact text transcript. Keeps the most recent sections within `maxChars`.
 */
export const digest = (entries: readonly unknown[], maxChars: number): string => {
  const sections = (entries as Entry[]).map(section).filter(Boolean);
  const kept: string[] = [];
  let size = 0;
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    const s = sections[i]!;
    if (size + s.length > maxChars && kept.length) break;
    kept.unshift(s.length > maxChars ? s.slice(-maxChars) : s);
    size += s.length + 2;
  }
  if (kept.length < sections.length) kept.unshift('[Earlier conversation omitted]');
  return kept.join('\n\n');
};
