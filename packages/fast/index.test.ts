import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { childExtensions } from '@nicknisi/pi-shared';
import fastExtension from './index.js';

type Handler = (event: any, ctx: any) => any;

/** Minimal ExtensionAPI double that records handlers and commands. */
function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const api = {
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: (name: string, command: any) => commands.set(name, command),
  };
  const emit = (name: string, event: any, ctx: any) => (handlers.get(name) ?? []).map((h) => h(event, ctx)).at(-1);
  return { api: api as never, emit, commands };
}

const model = { provider: 'anthropic', id: 'claude-opus-5-5', api: 'anthropic-messages' };
const ctx = {
  model,
  cwd: '/nonexistent',
  hasUI: false,
  isProjectTrusted: () => false,
  modelRegistry: { isUsingOAuth: () => false },
  ui: { notify() {}, setStatus() {} },
};

// Never read the real ~/.pi/agent/configs/fast.json.
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir: string;
beforeAll(() => {
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-fast-index-'));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterAll(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});
afterEach(() => childExtensions().delete('fast'));

describe('Anthropic Fast cost', () => {
  const reply = () => ({
    role: 'assistant',
    provider: 'anthropic',
    stopReason: 'stop',
    usage: { cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } },
  });

  it('prices a Fast reply at 2x once, and leaves standard replies alone', async () => {
    const pi = fakePi();
    fastExtension(pi.api);
    pi.emit('session_start', {}, ctx);
    const request = () => pi.emit('before_provider_request', { payload: { model: model.id } }, ctx);

    request();
    expect(pi.emit('message_end', { message: reply() }, ctx)).toBeUndefined(); // /fast is off

    await pi.commands.get('fast')!.handler('', ctx);
    request();
    expect(pi.emit('message_end', { message: reply() }, ctx)?.message.usage.cost.total).toBe(6);
    // No new request, so a second assistant message is not doubled again.
    expect(pi.emit('message_end', { message: reply() }, ctx)).toBeUndefined();
  });

  it('leaves Codex Fast replies at the standard estimate', async () => {
    const codex = { provider: 'openai-codex', id: 'gpt-6.2-sol', api: 'openai-codex-responses' };
    const codexCtx = { ...ctx, model: codex, modelRegistry: { isUsingOAuth: () => true } };
    const pi = fakePi();
    fastExtension(pi.api);
    pi.emit('session_start', {}, codexCtx);
    await pi.commands.get('fast')!.handler('', codexCtx);

    expect(pi.emit('before_provider_request', { payload: { model: codex.id } }, codexCtx)).toMatchObject({
      service_tier: 'priority',
    });
    expect(pi.emit('message_end', { message: { ...reply(), provider: 'openai-codex' } }, codexCtx)).toBeUndefined();
  });
});

describe('Fast mode refused by the plan', () => {
  it('falls back to standard speed for that model and tells the user', async () => {
    const codex = { provider: 'openai-codex', id: 'gpt-6.2-sol', api: 'openai-codex-responses' };
    const notes: string[] = [];
    const codexCtx = {
      ...ctx,
      model: codex,
      hasUI: true,
      modelRegistry: { isUsingOAuth: () => true },
      ui: { notify: (text: string) => notes.push(text), setStatus() {} },
    };
    const pi = fakePi();
    fastExtension(pi.api);
    pi.emit('session_start', {}, codexCtx);
    await pi.commands.get('fast')!.handler('', codexCtx);
    const request = () => pi.emit('before_provider_request', { payload: { model: codex.id } }, codexCtx);

    expect(request()).toEqual({ model: codex.id, service_tier: 'priority' });
    pi.emit(
      'message_end',
      {
        message: {
          role: 'assistant',
          provider: 'openai-codex',
          model: codex.id,
          stopReason: 'error',
          errorMessage: "Codex error: Fast mode isn't available for the selected model in your workspace.",
        },
      },
      codexCtx,
    );
    expect(notes.at(-1)).toContain('openai-codex/gpt-6.2-sol');
    expect(request()).toBeUndefined();
  });
});

describe('fast mode in subagent children', () => {
  it('children follow the parent session /fast toggle and share its cooldown', async () => {
    const parent = fakePi();
    fastExtension(parent.api);
    parent.emit('session_start', {}, ctx);

    const childFactory = childExtensions().get('fast');
    expect(childFactory).toBeDefined();
    const child = fakePi();
    await childFactory!(child.api);
    const request = () => child.emit('before_provider_request', { payload: { model: model.id } }, ctx);

    expect(request()).toBeUndefined(); // /fast is off by default
    await parent.commands.get('fast')!.handler('', ctx);
    expect(request()).toEqual({ model: model.id, speed: 'fast' });

    // A rate limit in a child drops the whole session to standard speed.
    child.emit(
      'message_end',
      { message: { role: 'assistant', stopReason: 'error', errorMessage: '429 {"type":"rate_limit_error"}' } },
      ctx,
    );
    expect(request()).toBeUndefined();
    expect(parent.emit('before_provider_request', { payload: { model: model.id } }, ctx)).toBeUndefined();

    parent.emit('session_shutdown', {}, ctx);
    expect(childExtensions().has('fast')).toBe(false);
  });
});

describe('cooldown footer', () => {
  afterEach(() => vi.useRealTimers());

  it('clears "fast (cooldown)" when the cooldown ends', async () => {
    vi.useFakeTimers();
    const statuses: (string | undefined)[] = [];
    const uiCtx = {
      ...ctx,
      hasUI: true,
      ui: { notify() {}, setStatus: (_id: string, text?: string) => statuses.push(text) },
    };
    const pi = fakePi();
    fastExtension(pi.api);
    pi.emit('session_start', {}, uiCtx);
    await pi.commands.get('fast')!.handler('', uiCtx);
    pi.emit('before_provider_request', { payload: { model: model.id } }, uiCtx);
    pi.emit(
      'message_end',
      { message: { role: 'assistant', stopReason: 'error', errorMessage: '429 {"type":"rate_limit_error"}' } },
      uiCtx,
    );
    expect(statuses.at(-1)).toBe('fast (cooldown)');

    vi.advanceTimersByTime(60_000);
    expect(statuses.at(-1)).toBe('fast');
    pi.emit('session_shutdown', {}, uiCtx);
  });
});
