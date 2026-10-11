import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it } from 'vitest';
import agentUrls from './index.js';

const previous = process.env.PI_SUBAGENTS_DIR;
afterEach(() => {
  if (previous === undefined) delete process.env.PI_SUBAGENTS_DIR;
  else process.env.PI_SUBAGENTS_DIR = previous;
});

it('reads run records from $PI_SUBAGENTS_DIR/runs when set', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-urls-'));
  try {
    mkdirSync(join(root, 'runs', 'subagents'), { recursive: true });
    writeFileSync(
      join(root, 'runs', 'subagents', 'abc123.json'),
      JSON.stringify({ runId: 'abc123', namespace: 'subagents', status: 'completed', promptPreview: 'relocated' }),
    );
    process.env.PI_SUBAGENTS_DIR = root;
    const tools = new Map<string, { execute: (...args: any[]) => Promise<{ content: { text: string }[] }> }>();
    agentUrls({ registerTool: (t: any) => tools.set(t.name, t), registerCommand: () => {} } as unknown as ExtensionAPI);
    const listed = await tools.get('list_agent_runs')!.execute('id', {});
    expect(listed.content[0]!.text).toContain('agent://subagents/abc123');
    const read = await tools.get('read_agent_url')!.execute('id', { uri: 'agent://subagents/abc123' });
    expect(read.content[0]!.text).toContain('relocated');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
