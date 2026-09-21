import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uuidv7 } from '@earendil-works/pi-ai';
import {
  createEventBus,
  type EventBus,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import extension, {
  INFO_COMMAND,
  MAX_NOTE_LENGTH,
  NOW_COMMAND,
  STATE_ENTRY,
  TOOL_NAME,
  readHandoffState,
  validateNote,
  type HandoffState,
} from './extensions/self-compact/self-compact.js';

const BOUNDARY = join(dirname(fileURLToPath(import.meta.url)), 'verify', 'boundary.mjs');

type EventResult = unknown;
type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<EventResult> | EventResult;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;

interface SentMessage {
  customType?: string | undefined;
  content: unknown;
  options: { triggerTurn?: boolean; deliverAs?: string } | undefined;
}

interface Harness {
  events: EventBus;
  call(note: unknown): Promise<unknown>;
  entries: SessionEntry[];
  appended: Array<{ type: string; data: unknown }>;
  active(): string[];
  state(): HandoffState | undefined;
  setAppendThrow(value: boolean): void;
  ctx: ExtensionContext;
  fire(event: string, payload?: unknown): Promise<EventResult[]>;
  runCommand(name: string, args?: string): Promise<void>;
  setFlag(name: string, value: string): void;
  setUsage(tokens: number | null): void;
  widget(): string[] | undefined;
  sent(): SentMessage[];
  notes(): Array<{ message: string; type: string }>;
}

interface HarnessOptions {
  initialActive?: string[];
  contextWindow?: number;
  flags?: Record<string, string>;
}

function makeHarness(options: HarnessOptions | string[] = {}): Harness {
  const opts: HarnessOptions = Array.isArray(options) ? { initialActive: options } : options;
  const initialActive = opts.initialActive ?? ['read', 'bash', 'edit', 'write', TOOL_NAME];
  const contextWindow = opts.contextWindow ?? 1_000_000;

  const entries: SessionEntry[] = [];
  const appended: Array<{ type: string; data: unknown }> = [];
  let active = [...initialActive];
  let appendThrows = false;
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, CommandHandler>();
  const flags = new Map<string, string>();
  const sentMessages: SentMessage[] = [];
  const notifications: Array<{ message: string; type: string }> = [];
  let widgetContent: string[] | undefined;
  let usageTokens: number | null = null;

  const events = createEventBus();
  const pi = {
    events,
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    on: (event: string, handler: EventHandler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerCommand: (name: string, o: { handler: CommandHandler }) => commands.set(name, o.handler),
    registerFlag: (name: string, o: { default?: string }) => {
      if (o.default !== undefined && !flags.has(name)) flags.set(name, o.default);
    },
    getFlag: (name: string) => flags.get(name),
    appendEntry: (type: string, data: unknown) => {
      if (appendThrows) throw new Error('simulated persistence failure (disk full)');
      appended.push({ type, data });
      entries.push({
        type: 'custom',
        customType: type,
        data,
        id: uuidv7(),
        parentId: null,
        timestamp: new Date().toISOString(),
      } as unknown as SessionEntry);
    },
    getAllTools: () => initialActive.map((name) => ({ name })),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = [...names];
    },
    sendMessage: (message: { customType?: string; content: unknown }, options?: SentMessage['options']) => {
      sentMessages.push({ customType: message.customType, content: message.content, options });
    },
  } as unknown as ExtensionAPI;

  // Seed explicit flag overrides (applied after registerFlag defaults below).
  const overrides = opts.flags ?? {};

  extension(pi);
  for (const [name, value] of Object.entries(overrides)) flags.set(name, value);

  const ctx = {
    hasUI: true,
    model: { contextWindow },
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => 'session-1',
      getSessionFile: () => undefined,
    },
    isIdle: () => true,
    getContextUsage: () => ({
      tokens: usageTokens,
      contextWindow,
      percent: usageTokens === null ? null : (usageTokens / contextWindow) * 100,
    }),
    ui: {
      notify: (message: string, type = 'info') => notifications.push({ message, type }),
      setWidget: (_key: string, content: string[] | undefined) => {
        widgetContent = content;
      },
    },
  } as unknown as ExtensionContext;

  const tool = tools.get(TOOL_NAME);
  if (!tool) throw new Error('self_compact tool was not registered');

  return {
    events,
    call: (note: unknown) => tool.execute('call-1', { note_to_self: note }, undefined, undefined, ctx),
    entries,
    appended,
    active: () => active,
    state: () => readHandoffState(entries),
    setAppendThrow: (value: boolean) => {
      appendThrows = value;
    },
    ctx,
    fire: async (event: string, payload: unknown = { type: event }) => {
      const list = handlers.get(event) ?? [];
      const results: EventResult[] = [];
      for (const handler of list) results.push(await handler(payload, ctx));
      return results;
    },
    runCommand: async (name: string, args = '') => {
      const handler = commands.get(name);
      if (!handler) throw new Error(`command ${name} not registered`);
      await handler(args, ctx);
    },
    setFlag: (name: string, value: string) => flags.set(name, value),
    setUsage: (tokens: number | null) => {
      usageTokens = tokens;
    },
    widget: () => widgetContent,
    sent: () => sentMessages,
    notes: () => notifications,
  };
}

describe('note validation', () => {
  it('rejects a blank note without changing state', async () => {
    const h = makeHarness();
    await expect(h.call('')).rejects.toThrow(/blank/);
    expect(h.state()).toBeUndefined();
    expect(h.appended).toHaveLength(0);
  });

  it('rejects a whitespace-only note', async () => {
    const h = makeHarness();
    await expect(h.call('   \n\t  ')).rejects.toThrow(/blank/);
    expect(h.state()).toBeUndefined();
  });

  it('accepts a note of exactly 24,000 characters', async () => {
    const h = makeHarness();
    const note = 'a'.repeat(MAX_NOTE_LENGTH);
    await expect(h.call(note)).resolves.toBeTruthy();
    expect(h.state()?.note).toBe(note);
  });

  it('rejects a note of 24,001 characters without changing state', async () => {
    const h = makeHarness();
    const note = 'a'.repeat(MAX_NOTE_LENGTH + 1);
    await expect(h.call(note)).rejects.toThrow(/at most 24000/);
    expect(h.state()).toBeUndefined();
  });

  it('preserves leading and trailing whitespace verbatim', async () => {
    const h = makeHarness();
    const note = '   keep me\n  indented next action  ';
    await h.call(note);
    expect(h.state()?.note).toBe(note);
  });

  it('preserves multiline Unicode content verbatim', async () => {
    const h = makeHarness();
    const note = 'résumé étape 1 → 完了\n第二段階: fix café\n🚀 ship';
    await h.call(note);
    expect(h.state()?.note).toBe(note);
  });

  it('uses JS string-length semantics for the boundary (validateNote)', () => {
    expect(validateNote('a'.repeat(MAX_NOTE_LENGTH)).ok).toBe(true);
    expect(validateNote('a'.repeat(MAX_NOTE_LENGTH + 1)).ok).toBe(false);
    // An astral character is length 2 in JS string units.
    expect('🚀'.length).toBe(2);
    expect(validateNote('🚀'.repeat(MAX_NOTE_LENGTH / 2)).ok).toBe(true);
    expect(validateNote('🚀'.repeat(MAX_NOTE_LENGTH / 2 + 1)).ok).toBe(false);
  });

  it('reports persistence failure as failure without recording success', async () => {
    const h = makeHarness();
    h.setAppendThrow(true);
    await expect(h.call('do the thing')).rejects.toThrow(/persistence failure/);
    expect(h.state()).toBeUndefined();
    expect(h.appended).toHaveLength(0);
  });

  it('is idempotent on a duplicate call with the same note (retry)', async () => {
    const h = makeHarness();
    await h.call('same note');
    const first = h.state();
    await h.call('same note');
    const second = h.state();
    expect(second?.cycleId).toBe(first?.cycleId);
    // No second state entry appended for the idempotent retry.
    expect(h.appended.filter((a) => a.type === STATE_ENTRY)).toHaveLength(1);
  });

  it('rejects replacing a pending handoff with a different note', async () => {
    const h = makeHarness();
    await h.call('first note');
    await expect(h.call('different note')).rejects.toThrow(/different self_compact handoff/i);
    expect(h.state()?.note).toBe('first note');
  });
});

describe('handoff reservation', () => {
  it('captures the prior active-tool selection once and locks to self_compact', async () => {
    const h = makeHarness(['read', 'bash', 'edit', 'write', TOOL_NAME]);
    await h.call('checkpoint');
    expect(h.state()?.originalActiveTools).toEqual(['read', 'bash', 'edit', 'write', TOOL_NAME]);
    expect(h.active()).toEqual([TOOL_NAME]);
  });

  it('does not overwrite the original snapshot on retry after the lock', async () => {
    const h = makeHarness(['read', 'bash', TOOL_NAME]);
    await h.call('checkpoint');
    // Locked now; a retry must keep the original (unlocked) snapshot.
    await h.call('checkpoint');
    expect(h.state()?.originalActiveTools).toEqual(['read', 'bash', TOOL_NAME]);
  });
});

describe('threshold enforcement', () => {
  it('injects soft guidance once per cycle and not again at the same level', async () => {
    const h = makeHarness({ contextWindow: 1_000_000 });
    await h.fire('session_start');
    h.setUsage(100000);
    await h.fire('agent_settled');
    expect(h.sent()).toHaveLength(0);
    h.setUsage(230000); // >= soft 225k
    await h.fire('agent_settled');
    expect(h.sent().filter((m) => m.customType === 'self-compact:guidance-soft')).toHaveLength(1);
    await h.fire('agent_settled');
    expect(h.sent().filter((m) => m.customType === 'self-compact:guidance-soft')).toHaveLength(1);
  });

  it('escalates to a stronger warning when usage crosses the warning threshold', async () => {
    const h = makeHarness({ contextWindow: 1_000_000 });
    await h.fire('session_start');
    h.setUsage(230000);
    await h.fire('turn_end');
    h.setUsage(255000); // >= warning 250k
    await h.fire('turn_end');
    expect(h.sent().some((m) => m.customType === 'self-compact:guidance-warning')).toBe(true);
  });

  it('keeps ordinary tools executable below the hard cutoff', async () => {
    const h = makeHarness({ contextWindow: 1_000_000 });
    await h.fire('session_start');
    h.setUsage(255000); // warning, below hard 270k
    await h.fire('turn_end');
    const [result] = await h.fire('tool_call', { type: 'tool_call', toolName: 'bash', toolCallId: 't1' });
    expect(result).toBeUndefined();
  });

  it('gates ordinary tools at the tool_call boundary once past the hard cutoff', async () => {
    const h = makeHarness({ contextWindow: 1_000_000 });
    await h.fire('session_start');
    h.setUsage(300000); // >= hard 270k
    const [blocked] = await h.fire('tool_call', { type: 'tool_call', toolName: 'bash', toolCallId: 't1' });
    expect((blocked as { block?: boolean }).block).toBe(true);
    expect(h.active()).toEqual([TOOL_NAME]);
    const [allowed] = await h.fire('tool_call', { type: 'tool_call', toolName: TOOL_NAME, toolCallId: 't2' });
    expect(allowed).toBeUndefined();
  });

  it('keeps hard enforcement latched until native compaction succeeds', async () => {
    const h = makeHarness();
    await h.fire('session_start');
    h.setUsage(300000);
    await h.fire('turn_end');
    h.setUsage(100000);
    await h.fire('turn_end');
    const [blocked] = await h.fire('tool_call', { toolName: 'bash' });
    expect(blocked).toMatchObject({ block: true });
    expect(h.active()).toEqual([TOOL_NAME]);
    await h.fire('session_compact', { reason: 'manual' });
    expect(h.active()).toContain('bash');
    expect(h.active()).toContain(TOOL_NAME);
    const [allowed] = await h.fire('tool_call', { toolName: 'bash' });
    expect(allowed).toBeUndefined();
  });

  it('sends only the strongest guidance on a direct jump to hard (no soft/warning cascade)', async () => {
    const h = makeHarness({ contextWindow: 1_000_000 });
    await h.fire('session_start');
    h.setUsage(320000); // straight past soft/warning to hard
    await h.fire('agent_settled');
    expect(h.sent().some((m) => m.customType === 'self-compact:guidance-soft')).toBe(false);
    expect(h.sent().some((m) => m.customType === 'self-compact:guidance-warning')).toBe(false);
    expect(h.active()).toEqual([TOOL_NAME]);
  });

  it('shows unknown usage as ?% and neither enforces nor announces on a null measurement', async () => {
    const h = makeHarness({ contextWindow: 1_000_000 });
    await h.fire('session_start');
    h.setUsage(null);
    await h.fire('agent_settled');
    expect(h.widget()?.[0]).toContain('?%');
    expect(h.sent()).toHaveLength(0);
    expect(h.active()).toContain('bash');
  });

  it('fails closed at the execution gate when thresholds cannot fit the model window', async () => {
    const h = makeHarness({ contextWindow: 200000 }); // 225k/250k defaults impossible here
    await h.fire('session_start');
    expect(h.notes().some((n) => n.type === 'error')).toBe(true);
    const [blocked] = await h.fire('tool_call', { type: 'tool_call', toolName: 'bash', toolCallId: 't1' });
    expect((blocked as { block?: boolean }).block).toBe(true);
    const [allowed] = await h.fire('tool_call', { type: 'tool_call', toolName: TOOL_NAME, toolCallId: 't2' });
    expect(allowed).toBeUndefined();
  });

  it('re-resolves on model selection and keeps failing closed on an incompatible window', async () => {
    const h = makeHarness({ contextWindow: 200000 });
    await h.fire('session_start');
    await h.fire('model_select', { type: 'model_select' });
    const [blocked] = await h.fire('tool_call', { type: 'tool_call', toolName: 'bash', toolCallId: 't1' });
    expect((blocked as { block?: boolean }).block).toBe(true);
  });

  it('delivers guidance without triggering a turn, so a finished task does not restart', async () => {
    const h = makeHarness({ contextWindow: 1_000_000 });
    await h.fire('session_start');
    h.setUsage(230000);
    await h.fire('agent_settled');
    expect(h.sent()).toHaveLength(1); // queued for the next real turn, not a new turn
    expect(h.sent()[0]?.options).toEqual({ triggerTurn: false, deliverAs: 'nextTurn' });
  });

  it('steers ongoing work at warning instead of waiting for the task to finish', async () => {
    const h = makeHarness();
    await h.fire('session_start');
    h.ctx.isIdle = () => false;
    h.setUsage(255000);
    await h.fire('turn_end');
    expect(h.sent()[0]?.options).toEqual({ triggerTurn: false, deliverAs: 'steer' });
  });

  it('lets the model answer a hard-cutoff tool rejection with self_compact', async () => {
    const h = makeHarness();
    await h.fire('session_start');
    h.setUsage(300000);
    const [blocked] = await h.fire('tool_call', { toolName: 'bash' });
    expect(blocked).toMatchObject({ block: true });
    expect((blocked as { terminate?: boolean }).terminate).not.toBe(true);
  });
});

describe('handoff lifecycle continuation waiting', () => {
  it('keeps the settled handler alive beyond 30 seconds until the continuation finishes', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      await h.call('Continue a long-running task');
      h.entries.push({
        type: 'custom',
        customType: STATE_ENTRY,
        data: { ...h.state(), phase: 'ready-to-deliver' },
        id: 'ready',
        parentId: null,
        timestamp: new Date().toISOString(),
      } as SessionEntry);
      let idleChecks = 0;
      let completed = false;
      h.ctx.isIdle = () => ++idleChecks === 1 || completed;
      let returned = false;
      const running = h.fire('agent_settled').then(() => {
        returned = true;
      });
      await vi.advanceTimersByTimeAsync(31000);
      expect(returned).toBe(false);
      completed = true;
      await vi.advanceTimersByTimeAsync(100);
      await running;
      expect(h.active()).toContain(TOOL_NAME);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('recovery across tree branches', () => {
  it('releases an abandoned branch hard lock and restores it only when returning to that branch', async () => {
    const h = makeHarness(['read', 'bash', TOOL_NAME]);
    await h.fire('session_start');
    h.setUsage(300000);
    await h.fire('turn_end');
    const lockedBranch = [...h.entries];
    expect(h.active()).toEqual([TOOL_NAME]);
    await h.fire('session_before_tree');
    h.entries.splice(0);
    h.setUsage(100000);
    await h.fire('session_tree');
    expect(h.active()).toEqual(['read', 'bash', TOOL_NAME]);
    expect((await h.fire('tool_call', { toolName: 'bash' }))[0]).toBeUndefined();
    await h.fire('session_before_tree');
    h.entries.push(...lockedBranch);
    await h.fire('session_tree');
    expect(h.active()).toEqual([TOOL_NAME]);
    expect((await h.fire('tool_call', { toolName: 'bash' }))[0]).toMatchObject({ block: true });
  });

  it('restores ordinary tools when leaving a pending handoff branch', async () => {
    const h = makeHarness(['read', TOOL_NAME]);
    await h.fire('session_start');
    await h.call('branch-specific unfinished action');
    await h.fire('session_before_tree');
    h.entries.splice(0);
    await h.fire('session_tree');
    expect(h.active()).toEqual(['read', TOOL_NAME]);
    expect(h.state()).toBeUndefined();
  });
});

describe('recovery after interrupted compaction', () => {
  it('makes a persisted in-flight handoff retryable on reload', async () => {
    const h = makeHarness();
    await h.call('saved unfinished action');
    h.entries.push({
      type: 'custom',
      customType: STATE_ENTRY,
      data: { ...h.state(), phase: 'compacting' },
      id: 'interrupted',
      parentId: null,
      timestamp: new Date().toISOString(),
    } as SessionEntry);
    await h.fire('session_start');
    expect(h.state()?.phase).toBe('failed');
    expect(h.active()).toEqual([TOOL_NAME]);
    await h.runCommand(NOW_COMMAND);
    expect(String(h.sent()[0]?.content)).toContain('saved unfinished action');
    await h.call('saved unfinished action');
    expect(h.state()?.phase).toBe('pending');
  });
});

describe('statusline color integration', () => {
  it('publishes zone colors while keeping the standalone widget as a fallback', async () => {
    const h = makeHarness();
    const colors: unknown[] = [];
    h.events.on('self-compact:context-color', (color) => colors.push(color));
    await h.fire('session_start');
    expect(colors.at(-1)).toBe('dim');
    for (const [tokens, expected] of [
      [139000, 'success'],
      [230000, 'accent'],
      [255000, 'warning'],
      [270000, 'error'],
    ] as const) {
      h.setUsage(tokens);
      await h.fire('turn_end');
      expect(colors.at(-1)).toBe(expected);
      expect(h.widget()).toBeDefined();
    }
  });

  it('hides the duplicate widget when statusline claims the bar, and restores it on release', async () => {
    const h = makeHarness();
    await h.fire('session_start');
    expect(h.widget()).toBeDefined();
    h.events.emit('statusline:context-bar', true);
    expect(h.widget()).toBeUndefined();
    h.setUsage(255000);
    await h.fire('turn_end');
    expect(h.widget()).toBeUndefined();
    h.events.emit('statusline:context-bar', false);
    expect(h.widget()).toBeDefined();
  });

  it('discovers an already loaded statusline and clears its color on shutdown', async () => {
    const h = makeHarness();
    const colors: unknown[] = [];
    h.events.on('statusline:request-context-bar', () => h.events.emit('statusline:context-bar', true));
    h.events.on('self-compact:context-color', (color) => colors.push(color));
    await h.fire('session_start');
    expect(h.widget()).toBeUndefined();
    await h.fire('session_shutdown');
    expect(colors.at(-1)).toBeUndefined();
    h.events.emit('statusline:context-bar', false);
    expect(h.widget()).toBeUndefined();
  });
});

describe('human commands', () => {
  it('/self-compact-info reports resolved thresholds without sending a model message', async () => {
    const h = makeHarness({ contextWindow: 1_000_000 });
    await h.fire('session_start');
    await h.runCommand(INFO_COMMAND);
    expect(h.sent()).toHaveLength(0);
    const info = h.notes().find((n) => n.message.startsWith('self-compact info:'));
    expect(info).toBeDefined();
    expect(info?.message).toContain('resolved:');
  });

  it('/self-compact-now includes a pending note verbatim for retry', async () => {
    const h = makeHarness({ contextWindow: 1_000_000 });
    await h.fire('session_start');
    await h.call('EXACT NEXT ACTION: run the failing test');
    await h.runCommand(NOW_COMMAND);
    const req = h.sent().find((m) => m.customType === 'self-compact:manual-request');
    expect(req).toBeDefined();
    expect(String(req?.content)).toContain('EXACT NEXT ACTION: run the failing test');
  });

  it('/self-compact-now on a fresh session asks the model to write a note and compact', async () => {
    const h = makeHarness({ contextWindow: 1_000_000 });
    await h.fire('session_start');
    await h.runCommand(NOW_COMMAND);
    const req = h.sent().find((m) => m.customType === 'self-compact:manual-request');
    expect(String(req?.content)).toMatch(/note_to_self/);
  });
});

describe('boundary helper', () => {
  let repo: string;
  let baseline: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'self-compact-boundary-'));
    baseline = join(mkdtempSync(join(tmpdir(), 'self-compact-baseline-')), 'baseline.json');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    mkdirSync(join(repo, 'other'), { recursive: true });
    mkdirSync(join(repo, 'packages', 'checkpoint'), { recursive: true });
    writeFileSync(join(repo, 'other', 'keep.txt'), 'unrelated\n');
    writeFileSync(join(repo, 'dirty.txt'), 'pre-existing dirty\n');
    writeFileSync(join(repo, 'packages', 'checkpoint', 'a.txt'), 'owned\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const run = (command: string) => {
    try {
      execFileSync('node', [BOUNDARY, command], {
        env: { ...process.env, SELF_COMPACT_BOUNDARY_ROOT: repo, SELF_COMPACT_BOUNDARY_BASELINE: baseline },
        stdio: 'pipe',
      });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? 1;
    }
  };

  it('fails check when the baseline is missing', () => {
    expect(run('check')).not.toBe(0);
  });

  it('passes check immediately after capture', () => {
    expect(run('capture')).toBe(0);
    expect(run('check')).toBe(0);
  });

  it('detects a modified unrelated file', () => {
    run('capture');
    writeFileSync(join(repo, 'other', 'keep.txt'), 'tampered\n');
    expect(run('check')).not.toBe(0);
  });

  it('detects an added unrelated file', () => {
    run('capture');
    writeFileSync(join(repo, 'other', 'new.txt'), 'sneaked in\n');
    expect(run('check')).not.toBe(0);
  });

  it('detects a modified pre-existing dirty file', () => {
    run('capture');
    writeFileSync(join(repo, 'dirty.txt'), 'changed\n');
    expect(run('check')).not.toBe(0);
  });

  it('ignores changes inside the approved package path', () => {
    run('capture');
    writeFileSync(join(repo, 'packages', 'checkpoint', 'a.txt'), 'edited freely\n');
    writeFileSync(join(repo, 'packages', 'checkpoint', 'b.txt'), 'new owned file\n');
    expect(run('check')).toBe(0);
  });

  it('refuses to overwrite an existing baseline', () => {
    expect(run('capture')).toBe(0);
    expect(run('capture')).not.toBe(0);
  });
});
