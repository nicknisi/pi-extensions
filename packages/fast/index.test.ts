import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
