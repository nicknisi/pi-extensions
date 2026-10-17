import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';

// Each prompt() call runs the next scripted turn against a fake child session.
type Turn = (
  emit: (event: any) => void,
  reply: (text: string) => void,
  aborted: Promise<void>,
  push: (message: any) => void,
) => Promise<void>;

const harness = vi.hoisted(() => ({
  turns: [] as Turn[],
  prompts: [] as string[],
  loaderOptions: [] as any[],
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: vi.fn(async () => {
    const listeners: Array<(event: any) => void> = [];
    const messages: any[] = [];
    let abort!: () => void;
    const aborted = new Promise<void>((resolve) => (abort = resolve));
    const emit = (event: any) => {
      for (const listener of listeners) listener(event);
    };
    const reply = (text: string) => {
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text }],
        usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
        stopReason: 'stop',
      };
      messages.push(message);
      emit({ type: 'message_end', message });
    };
    return {
      session: {
        agent: { state: {} },
        messages,
        subscribe(listener: (event: any) => void) {
          listeners.push(listener);
          return () => {};
        },
        async prompt(text: string) {
          harness.prompts.push(text);
          const turn = harness.turns.shift();
          const push = (message: any) => {
            messages.push(message);
            emit({ type: 'message_end', message });
          };
          if (turn) await turn(emit, reply, aborted, push);
        },
        abort: vi.fn(async () => abort()),
        dispose: vi.fn(),
      },
    };
  }),
  DefaultResourceLoader: class {
    constructor(options: any) {
      harness.loaderOptions.push(options);
    }
    async reload() {}
  },
  defineTool: vi.fn((tool) => tool),
  getAgentDir: vi.fn(() => '/tmp/pi-agent-test'),
  ModelRuntime: class {
    static async create() {
      return {};
    }
  },
  resolveCliModel: vi.fn(() => ({ model: {} })),
  SessionManager: { inMemory: vi.fn(() => ({})) },
  SettingsManager: { inMemory: vi.fn(() => ({})) },
}));

import { childExtensions, createSubagentRuntime } from './subagents.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('subagent runtime robustness', () => {
  const saved = { depth: process.env.PI_SUBAGENT_DEPTH, child: process.env.PI_SUBAGENT_CHILD };

  beforeEach(() => {
    delete process.env.PI_SUBAGENT_DEPTH;
    delete process.env.PI_SUBAGENT_CHILD;
    harness.turns = [];
    harness.prompts = [];
    harness.loaderOptions = [];
  });

  afterEach(() => {
    if (saved.depth !== undefined) process.env.PI_SUBAGENT_DEPTH = saved.depth;
    if (saved.child !== undefined) process.env.PI_SUBAGENT_CHILD = saved.child;
  });

  it("aborts a silent child with kind 'stalled'", async () => {
    harness.turns.push(async (_emit, _reply, aborted) => aborted);
    const result = await createSubagentRuntime({ namespace: 'stall-test' }).spawn({
      prompt: 'hang',
      timeoutMs: 0,
      stallMs: 30,
    });
    expect(result).toMatchObject({ ok: false, kind: 'stalled' });
  });

  it("doesn't count time inside the child's tool calls toward the stall window", async () => {
    harness.turns.push(async (emit, reply) => {
      emit({ type: 'tool_execution_start', toolName: 'bash' });
      await sleep(80);
      emit({ type: 'tool_execution_end', toolName: 'bash' });
      reply('done');
    });
    const result = await createSubagentRuntime({ namespace: 'stall-tool-test' }).spawn({
      prompt: 'run tests',
      timeoutMs: 0,
      stallMs: 30,
    });
    expect(result).toMatchObject({ ok: true, text: 'done' });
  });

  it('tells the child the schema and corrects an invalid answer in-session', async () => {
    harness.turns.push(async (_emit, reply) => reply('the answer is three'));
    harness.turns.push(async (_emit, reply) => reply('{"count": 3}'));
    const schema = Type.Object({ count: Type.Number() });
    const result = await createSubagentRuntime({ namespace: 'schema-test' }).spawn({
      prompt: 'count things',
      timeoutMs: 0,
      outputSchema: schema,
    });
    expect(result).toMatchObject({ ok: true, data: { count: 3 } });
    expect(harness.prompts).toHaveLength(2);
    expect(harness.prompts[1]).toContain('Final message did not contain parseable JSON');
    expect(harness.loaderOptions[0].appendSystemPrompt.join('\n')).toContain('"count"');
  });

  it('gives up after five schema attempts', async () => {
    for (let i = 0; i < 6; i++) harness.turns.push(async (_emit, reply) => reply('{"count": "many"}'));
    const result = await createSubagentRuntime({ namespace: 'schema-limit-test' }).spawn({
      prompt: 'count things',
      timeoutMs: 0,
      outputSchema: Type.Object({ count: Type.Number() }),
    });
    expect(result).toMatchObject({ ok: false, kind: 'schema_invalid' });
    expect(harness.prompts).toHaveLength(5);
  });

  it("doesn't prompt a child that was aborted before it started", async () => {
    harness.turns.push(async (_emit, reply) => reply('should not run'));
    const controller = new AbortController();
    controller.abort();
    const result = await createSubagentRuntime({ namespace: 'pre-abort-test' }).spawn({
      prompt: 'too late',
      timeoutMs: 0,
      signal: controller.signal,
    });
    expect(result).toMatchObject({ ok: false, kind: 'aborted' });
    expect(harness.prompts).toEqual([]);
  });

  it("doesn't re-prompt for the schema after a provider error", async () => {
    harness.turns.push(async (_emit, reply, _aborted, push) => {
      reply('Let me look at the files first.');
      push({ role: 'assistant', content: [], stopReason: 'error', usage: { input: 0, output: 0, totalTokens: 0 } });
    });
    const result = await createSubagentRuntime({ namespace: 'schema-error-test' }).spawn({
      prompt: 'count',
      timeoutMs: 0,
      outputSchema: Type.Object({ count: Type.Number() }),
    });
    expect(result).toMatchObject({ ok: false });
    expect(harness.prompts).toHaveLength(1);
  });

  it('loads registered child extensions into every child', async () => {
    const factory = () => {};
    childExtensions().set('test-child-ext', factory);
    try {
      harness.turns.push(async (_emit, reply) => reply('ok'));
      await createSubagentRuntime({ namespace: 'child-ext-test' }).spawn({ prompt: 'hi', timeoutMs: 0 });
      expect(harness.loaderOptions[0].extensionFactories).toContainEqual({
        name: 'test-child-ext',
        factory,
        hidden: true,
      });
    } finally {
      childExtensions().delete('test-child-ext');
    }
  });
});
