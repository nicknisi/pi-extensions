import { uuidv7 } from '@earendil-works/pi-ai';
import {
  buildSessionContext,
  convertToLlm,
  getAgentDir,
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Box, Markdown, Text } from '@earendil-works/pi-tui';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Auto-recap: after N idle minutes, inject a dimmed recap card into the transcript.

type Config = { idleMinutes: number; model?: { provider: string; id: string } };

const DEFAULT_CONFIG: Config = { idleMinutes: 3 };
// Resolved per call, not at module load: `getAgentDir()` honours the agent-dir
// env var, so hardcoding ~/.pi/agent would read (and write) the wrong file for
// anyone running a non-default agent dir. Per-call also means a config written
// by `saveConfig` is visible to the next read.
function configPath(): string {
  return path.join(getAgentDir(), 'configs', 'recap.json');
}
const ENTRY_TYPE = 'recap';
const TICK_MS = 30_000;
const MIN_BRANCH_LEN = 4;
const MAX_CARD_LINES = 5;
const MAX_TOOL_ARGS_CHARS = 200;

let lastActivity = Date.now();
let firedThisIdle = false;
let timer: ReturnType<typeof setInterval> | null = null;
let piRef: ExtensionAPI | null = null;
let lastModel: ExtensionContext['model'] = undefined;

function readConfig(): Config {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return {
      idleMinutes: typeof parsed.idleMinutes === 'number' ? parsed.idleMinutes : DEFAULT_CONFIG.idleMinutes,
      model: parsed.model && typeof parsed.model === 'object' ? parsed.model : undefined,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function writeConfig(c: Config) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(c, null, 2));
}

type Entry = { type: string; customType?: string };
type Message = { role?: string; content?: unknown };
type Block = { type?: string; text?: string; name?: string; arguments?: Record<string, unknown> };

function textParts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((p): p is Block => !!p && typeof p === 'object')
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string);
}

function toolLines(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((p): p is Block => !!p && typeof p === 'object')
    .filter((b) => b.type === 'toolCall' && typeof b.name === 'string')
    .map((b) => `Tool ${b.name} called with ${capArgs(JSON.stringify(b.arguments ?? {}))}`);
}

// write/edit calls carry whole file bodies; the recap only needs the gist.
function capArgs(args: string): string {
  return args.length <= MAX_TOOL_ARGS_CHARS ? args : args.slice(0, MAX_TOOL_ARGS_CHARS) + '…';
}

function buildConversation(messages: Message[]): string {
  const sections: string[] = [];
  for (const m of messages) {
    const role = m.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const lines: string[] = [];
    const tp = textParts(m.content);
    const t = tp.join('\n').trim();
    if (t) lines.push(`${role === 'user' ? 'User' : 'Assistant'}: ${t}`);
    if (role === 'assistant') lines.push(...toolLines(m.content));
    if (lines.length) sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}

function summaryPrompt(conversation: string): string {
  return [
    'Summarize this conversation so far as a concise recap.',
    'Include goals, key decisions, progress, and open items.',
    'Be terse — at most 6-8 lines. Use short markdown headings.',
    'Skip preamble; lead with the substance.',
    '',
    '<conversation>',
    conversation,
    '</conversation>',
  ].join('\n');
}

function capLines(text: string, max: number): string {
  const lines = text.split('\n');
  if (lines.length <= max) return text;
  return lines.slice(0, max).join('\n') + ' …';
}

async function generateSummary(ctx: ExtensionContext): Promise<string> {
  const cfg = readConfig();
  const configuredModel =
    cfg.model && typeof cfg.model.provider === 'string' && typeof cfg.model.id === 'string'
      ? ctx.modelRegistry.find(cfg.model.provider, cfg.model.id)
      : undefined;
  const model = configuredModel ?? ctx.model ?? lastModel;
  if (!model) {
    ctx.ui.notify('recap: no model available', 'warning');
    return '';
  }
  // Active context only: compaction summary + kept messages, not pre-compaction history.
  const conversation = buildConversation(convertToLlm(buildSessionContext(ctx.sessionManager.getBranch()).messages));
  if (!conversation.trim()) return '';
  const response = await ctx.modelRegistry.complete(
    model,
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: summaryPrompt(conversation) }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      reasoningEffort: 'low',
      cacheRetention: 'none',
      sessionId: uuidv7(),
    },
  );
  return response.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

async function injectRecap(ctx: ExtensionContext) {
  const summary = await generateSummary(ctx);
  if (!summary) return;
  piRef?.appendEntry(ENTRY_TYPE, { summary, ts: Date.now() });
}

async function maybeFire(ctx: ExtensionContext) {
  if (!ctx.isIdle() || firedThisIdle) return;
  const cfg = readConfig();
  if (Date.now() - lastActivity < cfg.idleMinutes * 60_000) return;
  const branch: Entry[] = ctx.sessionManager.getBranch();
  if (branch.filter((e) => e.type === 'message').length < MIN_BRANCH_LEN) return;
  // Nothing new since the last recap (e.g. a reopened session): don't re-fire.
  const last = [...branch]
    .reverse()
    .find(
      (e) =>
        e.type === 'message' || e.type === 'custom_message' || (e.type === 'custom' && e.customType === ENTRY_TYPE),
    );
  if (last?.type === 'custom') return;
  firedThisIdle = true;
  await injectRecap(ctx);
}

export default function (pi: ExtensionAPI) {
  piRef = pi;

  pi.on('session_start', async (_e, ctx) => {
    if (ctx.mode !== 'tui') return;
    lastActivity = Date.now();
    firedThisIdle = false;

    pi.registerEntryRenderer(ENTRY_TYPE, (entry, _opts, theme) => {
      const data = entry.data as { summary: string; ts: number };
      const dim = (s: string) => theme.fg('dim', s);
      // Theme-aware bg: same token pi's own summary cards (compaction, branch)
      // use, so the card stands out appropriately in every theme.
      const bg = (s: string) => theme.bg('customMessageBg', s);
      const box = new Box(1, 0, (s) => bg(dim(s)));
      box.addChild(new Text(dim(theme.bold('Recap')) + dim(` · ${new Date(data.ts).toLocaleTimeString()}`), 0, 0));
      box.addChild(new Markdown(capLines(data.summary, MAX_CARD_LINES), 0, 0, getMarkdownTheme()));
      return box;
    });

    timer = setInterval(() => {
      void maybeFire(ctx).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`recap: ${message}`, 'warning');
      });
    }, TICK_MS);
  });

  pi.on('before_agent_start', async (_e, ctx) => {
    lastActivity = Date.now();
    firedThisIdle = false;
    lastModel = ctx.model ?? lastModel;
  });

  pi.on('agent_settled', async (_e, ctx) => {
    lastActivity = Date.now();
    lastModel = ctx.model ?? lastModel;
  });

  pi.on('session_shutdown', async (_e, ctx) => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    void ctx;
  });

  pi.registerCommand('recap', {
    description: 'Inject a conversation recap into the transcript (generates if needed)',
    handler: async (_args, ctx) => {
      ctx.ui.notify('Generating recap...', 'info');
      await injectRecap(ctx);
    },
  });

  pi.registerCommand('recap-idle', {
    description: 'Set recap idle threshold in minutes',
    handler: async (args, ctx) => {
      const n = Number(args.trim());
      if (!Number.isFinite(n) || n <= 0) {
        ctx.ui.notify('usage: /recap-idle <minutes>', 'warning');
        return;
      }
      writeConfig({ ...readConfig(), idleMinutes: n });
      ctx.ui.notify(`recap idle → ${n}m`, 'info');
    },
  });
}
