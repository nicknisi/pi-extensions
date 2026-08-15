import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const assistantMessages = [
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'first turn' }],
    usage: {
      input: 10,
      output: 5,
      totalTokens: 15,
      cost: { total: 0.01 },
    },
    stopReason: 'toolUse',
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'final answer' }],
    usage: {
      input: 12,
      output: 3,
      totalTokens: 15,
      cost: { total: 0.02 },
    },
    stopReason: 'stop',
  },
];

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: vi.fn(async () => {
    const listeners: Array<(event: any) => void> = [];
    return {
      session: {
        agent: { state: {} },
        messages: assistantMessages,
        subscribe(listener: (event: any) => void) {
          listeners.push(listener);
          return () => {};
        },
        async prompt() {
          for (const message of assistantMessages) {
            for (const listener of listeners) listener({ type: 'message_end', message });
          }
        },
        abort: vi.fn(),
        dispose: vi.fn(),
      },
    };
  }),
  DefaultResourceLoader: class {
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
  SessionManager: {
    inMemory: vi.fn(() => ({})),
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({})),
  },
}));

import { createSubagentRuntime } from './subagents.js';

describe('live subagent usage', () => {
  let previousDepth: string | undefined;
  let previousChild: string | undefined;
  let artifactsDir: string;

  beforeEach(() => {
    artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-live-usage-test-'));
    previousDepth = process.env.PI_SUBAGENT_DEPTH;
    previousChild = process.env.PI_SUBAGENT_CHILD;
    delete process.env.PI_SUBAGENT_DEPTH;
    delete process.env.PI_SUBAGENT_CHILD;
  });

  afterEach(() => {
    fs.rmSync(artifactsDir, { recursive: true, force: true });
    if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
    else process.env.PI_SUBAGENT_DEPTH = previousDepth;
    if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previousChild;
  });

  it('reports cumulative usage after each completed assistant response', async () => {
    const runtime = createSubagentRuntime({ namespace: 'live-usage-test', artifactsDir });
    const updates: number[] = [];
    const recorded: number[] = [];
    const persisted: number[] = [];

    const result = await runtime.spawn({
      prompt: 'test live usage',
      timeoutMs: 0,
      onUsage: (usage) => {
        updates.push(usage.totalTokens);
        const run = runtime.listRuns()[0];
        recorded.push(run?.usage?.totalTokens ?? -1);
        const artifact = JSON.parse(
          fs.readFileSync(path.join(artifactsDir, 'live-usage-test', `${run?.runId}.json`), 'utf8'),
        );
        persisted.push(artifact.usage?.totalTokens ?? -1);
      },
    });

    expect(result.ok).toBe(true);
    expect(updates).toEqual([15, 30]);
    expect(recorded).toEqual([15, 30]);
    expect(persisted).toEqual([15, 30]);
    expect(result.usage).toEqual({ inputTokens: 22, outputTokens: 8, totalTokens: 30, cost: 0.03 });
  });

  it('does not fail a run when a progress observer throws', async () => {
    const runtime = createSubagentRuntime({ namespace: 'live-usage-observer-test' });
    const result = await runtime.spawn({
      prompt: 'test observer isolation',
      timeoutMs: 0,
      onUsage: () => {
        throw new Error('observer failed');
      },
    });

    expect(result.ok).toBe(true);
    expect(result.usage.totalTokens).toBe(30);
  });
});
