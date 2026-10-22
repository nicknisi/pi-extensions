import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// DEFAULT_CONFIG_PATH is computed at import, so the mocked agent dir is fixed for the whole file.
const dir = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtempSync(join(tmpdir(), 'cloak-'));
});
vi.mock('@earendil-works/pi-coding-agent', () => ({ getAgentDir: () => dir }));

const { cloakText, loadState, default: cloak } = await import('./index.js');

afterEach(() => rmSync(join(dir, 'cloak.json'), { force: true }));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeConfig(config: unknown): string {
  const path = join(dir, 'cloak.json');
  writeFileSync(path, typeof config === 'string' ? config : JSON.stringify(config));
  return path;
}

const envRule = { filePattern: '**/.env*', cloakPattern: '^([A-Z0-9_]+)=(.+)$', replace: '$1=' };

type ToolResultHandler = (
  event: { toolName: string; input: Record<string, unknown>; content: { type: string; text?: string }[] },
  ctx: { cwd: string },
) => Promise<{ content: { type: string; text?: string }[] } | undefined>;

// Config is reloaded on session_start, which is how a session picks up the per-test file.
async function loadExtension(): Promise<ToolResultHandler> {
  const handlers = new Map<string, (...args: any[]) => any>();
  cloak({
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerCommand: () => {},
  } as unknown as ExtensionAPI);
  await handlers.get('session_start')!({}, { hasUI: false });
  return handlers.get('tool_result')! as ToolResultHandler;
}

function result(toolName: string, text: string, input: Record<string, unknown> = {}) {
  return { toolName, input, content: [{ type: 'text', text }] };
}

describe('tool_result hook', () => {
  it('redacts bash output when the command names a file the rule covers', async () => {
    writeConfig({ patterns: [envRule] });
    const onToolResult = await loadExtension();

    const bash = await onToolResult(result('bash', 'API_KEY=sk-abc123\nok', { command: 'cat .env' }), { cwd: dir });
    expect(bash?.content[0]!.text).toBe('API_KEY=*********\nok');
    const sourced = await onToolResult(result('bash', 'API_KEY=x', { command: 'source ./.env.local && env' }), {
      cwd: dir,
    });
    expect(sourced?.content[0]!.text).toBe('API_KEY=*');
  });

  it('leaves unrelated bash and grep output alone unless a rule is global', async () => {
    writeConfig({ patterns: [envRule] });
    let onToolResult = await loadExtension();
    expect(await onToolResult(result('bash', 'COUNT=3', { command: 'node script.js' }), { cwd: dir })).toBeUndefined();
    expect(await onToolResult(result('grep', 'SECRET=hunter2', { pattern: 'SECRET' }), { cwd: dir })).toBeUndefined();

    writeConfig({ patterns: [{ ...envRule, global: true }] });
    onToolResult = await loadExtension();
    const bash = await onToolResult(result('bash', 'COUNT=3', { command: 'node script.js' }), { cwd: dir });
    expect(bash?.content[0]!.text).toBe('COUNT=*');
    const grep = await onToolResult(result('grep', 'SECRET=hunter2', { pattern: 'SECRET' }), { cwd: dir });
    expect(grep?.content[0]!.text).toBe('SECRET=*******');
  });

  it('redacts grep output when its path or glob names files the rule covers', async () => {
    writeConfig({ patterns: [envRule] });
    const onToolResult = await loadExtension();
    const grep = await onToolResult(result('grep', 'SECRET=hunter2', { pattern: 'SECRET', path: '.env' }), {
      cwd: dir,
    });
    expect(grep?.content[0]!.text).toBe('SECRET=*******');
  });

  it('keeps read scoped to the rule file glob', async () => {
    writeConfig({ patterns: [envRule] });
    const onToolResult = await loadExtension();

    expect(await onToolResult(result('read', 'API_KEY=x', { path: 'src/config.ts' }), { cwd: dir })).toBeUndefined();
    const read = await onToolResult(result('read', 'API_KEY=x', { path: '.env' }), { cwd: dir });
    expect(read?.content[0]!.text).toBe('API_KEY=*');
  });

  it('fails closed when the config file exists but cannot be parsed', async () => {
    writeConfig('{ not json');
    const onToolResult = await loadExtension();

    for (const toolName of ['read', 'bash', 'grep']) {
      const out = await onToolResult(result(toolName, 'API_KEY=sk-abc123', { path: '.env' }), { cwd: dir });
      expect(out?.content).toHaveLength(1);
      expect(out?.content[0]!.text).toMatch(
        /^\[pi-cloak: \w+ output withheld because the cloak config could not be loaded/,
      );
      expect(out?.content[0]!.text).not.toContain('sk-abc123');
    }
  });

  it('passes output through when there is no config file', async () => {
    const onToolResult = await loadExtension();
    expect(await onToolResult(result('bash', 'API_KEY=sk-abc123'), { cwd: dir })).toBeUndefined();
  });
});

describe('loadState', () => {
  it('skips and reports an invalid rule while keeping the others', () => {
    const state = loadState(writeConfig({ patterns: [{ filePattern: '**/*', cloakPattern: '(' }, envRule] }));
    expect(state.rules).toHaveLength(1);
    expect(state.failClosed).toBeUndefined();
    expect(state.error).toContain('skipped rule #1');
    expect(cloakText('API_KEY=x', '.env', dir, state)).toBe('API_KEY=*');
  });

  it('fails closed on a parse error but not on a missing file', () => {
    expect(loadState(writeConfig('{')).failClosed).toBe(true);
    const missing = loadState(join(dir, 'missing.json'));
    expect(missing.failClosed).toBeUndefined();
    expect(missing.rules).toEqual([]);
  });
});

describe('cloakText', () => {
  it('matches multi-line secrets such as PEM blocks', () => {
    const state = loadState(
      writeConfig({
        patterns: [
          { filePattern: '**/*', cloakPattern: { pattern: '-----BEGIN [A-Z ]+-----[\\s\\S]*?-----END [A-Z ]+-----' } },
        ],
      }),
    );
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEv\nQIBADAN\n-----END PRIVATE KEY-----';
    const out = cloakText(`key:\n${pem}\ndone`, 'id.pem', dir, state);
    expect(out).toBe(`key:\n-${'*'.repeat(pem.length - 1)}\ndone`);
  });

  it('keeps per-line ^/$ anchoring and CRLF line endings', () => {
    const state = loadState(writeConfig({ patterns: [envRule] }));
    expect(cloakText('# c\r\nA=1\r\nB=22\r\n', '.env', dir, state)).toBe('# c\r\nA=*\r\nB=**\r\n');
  });

  it('with tryAllPatterns=false, stops at the first changing pattern per line', () => {
    const state = loadState(
      writeConfig({
        tryAllPatterns: false,
        patterns: [{ filePattern: '**/*', cloakPattern: ['aaa', 'bbb'] }],
      }),
    );
    expect(cloakText('aaa bbb\nbbb', 'f', dir, state)).toBe('a** bbb\nb**');
  });
});
