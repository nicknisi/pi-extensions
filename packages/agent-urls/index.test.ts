import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import agentUrls from './index.js';

type Tool = { execute: (...args: any[]) => Promise<{ content: { text: string }[]; structuredContent?: any }> };
type Command = {
  getArgumentCompletions: (prefix: string) => { value: string; label: string }[] | null;
  handler: (args: string, ctx: any) => Promise<void>;
};

const previous = process.env.PI_SUBAGENTS_DIR;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-urls-'));
  process.env.PI_SUBAGENTS_DIR = root;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.PI_SUBAGENTS_DIR;
  else process.env.PI_SUBAGENTS_DIR = previous;
});

function writeRun(namespace: string, record: Record<string, unknown>, mtimeSec?: number) {
  const dir = join(root, 'runs', namespace);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${record.runId as string}.json`);
  writeFileSync(file, JSON.stringify({ namespace, ...record }));
  if (mtimeSec !== undefined) utimesSync(file, mtimeSec, mtimeSec);
}

function load() {
  const tools = new Map<string, Tool>();
  let command: Command | undefined;
  const messages: any[] = [];
  agentUrls({
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand: (_name: string, c: Command) => (command = c),
    sendMessage: (m: any) => messages.push(m),
    on: () => {},
  } as unknown as ExtensionAPI);
  const read = async (uri: string) => (await tools.get('read_agent_url')!.execute('id', { uri })).content[0]!.text;
  const list = (params: Record<string, unknown> = {}) => tools.get('list_agent_runs')!.execute('id', params);
  return { tools, command: command!, messages, read, list };
}

it('reads run records from $PI_SUBAGENTS_DIR/runs when set', async () => {
  writeRun('subagents', { runId: 'abc123', status: 'completed', promptPreview: 'relocated' });
  const { list, read } = load();
  expect((await list()).content[0]!.text).toContain('agent://subagents/abc123');
  expect(await read('agent://subagents/abc123')).toContain('relocated');
});

describe('agent:// URI resolution', () => {
  beforeEach(() => {
    writeRun('subagents', { runId: 'abc123', status: 'completed', output: 'the output', error: 'boom' });
    writeRun('subagents', { runId: 'abd456', status: 'completed' });
    writeRun('workflows', { runId: 'xyz789', status: 'completed', output: 'wf' });
  });

  it('treats a second segment that is a leaf keyword as runId/leaf', async () => {
    const { read } = load();
    expect(await read('agent://abc123/output')).toBe('the output');
    expect(await read('agent://abc123/error')).toBe('boom');
  });

  it('treats two non-leaf segments as namespace/runId and scopes the search', async () => {
    const { read } = load();
    expect(await read('agent://workflows/xyz')).toContain('# agent://workflows/xyz789');
    await expect(read('agent://workflows/abc')).rejects.toThrow(
      /No subagent run matched 'abc' in namespace 'workflows'/,
    );
  });

  it('resolves unique prefixes and rejects ambiguous ones', async () => {
    const { read } = load();
    expect(await read('agent://abc')).toContain('agent://subagents/abc123');
    await expect(read('agent://ab')).rejects.toThrow(/Ambiguous run id 'ab'/);
  });

  it('rejects non-agent URIs and unknown leaves', async () => {
    const { read } = load();
    await expect(read('history://abc')).rejects.toThrow(/Unsupported URI/);
    await expect(read('agent://subagents/abc123/nope')).rejects.toThrow(/Unknown leaf/);
  });

  it('truncates long output to maxLines', async () => {
    writeRun('subagents', { runId: 'long1', output: Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') });
    const { tools } = load();
    const result = await tools.get('read_agent_url')!.execute('id', { uri: 'agent://long1/output', maxLines: 20 });
    expect(result.content[0]!.text).toContain('line 19');
    expect(result.content[0]!.text).not.toContain('line 20');
    expect(result.content[0]!.text).toContain('[truncated: 10 more line(s)]');
  });
});

it('keeps the newest runs when more records exist than the scan cap', async () => {
  // 2500 old records in a namespace that sorts first, one new record in one that sorts last.
  for (let i = 0; i < 2500; i++) writeRun('aaa', { runId: `old${i}` }, 1_000_000);
  writeRun('zzz', { runId: 'newest', startedAt: Date.now() });
  const { list, read } = load();
  expect((await list({ limit: 1 })).structuredContent.runs[0].url).toBe('agent://zzz/newest');
  expect(await read('agent://newest')).toContain('agent://zzz/newest');
});

it('reports running records whose host process is gone as stale', async () => {
  writeRun('subagents', { runId: 'ghost', status: 'running', hostPid: 2 ** 22 + 12345 });
  writeRun('subagents', { runId: 'live', status: 'running', hostPid: process.pid });
  const { list } = load();
  const runs = (await list()).structuredContent.runs;
  expect(runs.find((r: any) => r.runId === 'ghost').status).toBe('stale');
  expect(runs.find((r: any) => r.runId === 'live').status).toBe('running');
});

describe('/agent completions', () => {
  beforeEach(() => {
    writeRun('subagents', { runId: 'abc123' });
    writeRun('workflows', { runId: 'xyz789' });
  });

  it('completes subcommands', () => {
    const { command } = load();
    expect(command.getArgumentCompletions('r')?.map((i) => i.value)).toEqual(['read']);
  });

  it('keeps the subcommand in the completion value', () => {
    const { command } = load();
    const values = command.getArgumentCompletions('read ')?.map((i) => i.value);
    expect(values).toEqual(expect.arrayContaining(['read agent://subagents/abc123', 'read agent://workflows/xyz789']));
  });

  it('filters by the partially typed URI', () => {
    const { command } = load();
    expect(command.getArgumentCompletions('show agent://work')?.map((i) => i.value)).toEqual([
      'show agent://workflows/xyz789',
    ]);
    expect(command.getArgumentCompletions('read abc')?.map((i) => i.value)).toEqual(['read agent://subagents/abc123']);
  });

  it('does not suggest URIs after list', () => {
    const { command } = load();
    expect(command.getArgumentCompletions('list ')).toBeNull();
  });

  it('posts results without a redundant notify', async () => {
    const { command, messages } = load();
    const notes: string[] = [];
    await command.handler('read agent://abc123', { ui: { notify: (m: string) => notes.push(m) } });
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('agent://subagents/abc123');
    expect(notes).toEqual([]);
  });
});
