import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
let dir: string;
beforeEach(() => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), 'title-model-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', dir);
  mkdirSync(join(dir, 'configs'));
  writeFileSync(
    join(dir, 'configs/session-name.json'),
    JSON.stringify({ autoName: 'llm', llmModel: 'optional/org/model', setTitle: false }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function harness(mode: string) {
  const { default: extension } = await import('./index.js');
  const handlers = new Map<string, Handler>();
  const preferred = { provider: 'optional', id: 'org/model' };
  const current = { provider: 'session', id: 'current' };
  const getAvailableOfType = vi.fn(async () => {
    if (mode === 'rejects') throw new Error('lookup failed');
    return mode === 'usable' ? [preferred] : [];
  });
  const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true })); // OAuth may have no API key.
  const complete = vi.fn(async () => ({ stopReason: 'stop', content: [{ type: 'text', text: 'Generated title' }] }));
  const setSessionName = vi.fn();
  const ctx = {
    model: current,
    hasUI: false,
    modelRegistry: { find: () => preferred, getAvailableOfType, getApiKeyAndHeaders, complete },
    sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionContext;
  extension({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand() {},
    getSessionName: () => '',
    setSessionName,
  } as unknown as ExtensionAPI);
  const fire = (name: string, prompt = 'Fix the tests') => handlers.get(name)!({ prompt, messageType: 'user' }, ctx);
  return { ctx, preferred, current, getAvailableOfType, getApiKeyAndHeaders, complete, setSessionName, fire };
}

it.each(['unavailable', 'rejects', 'usable'])('selects title model when preference %s', async (mode) => {
  const h = await harness(mode);
  h.ctx.model = { ...h.current, id: 'changed' } as ExtensionContext['model'];
  h.fire('before_agent_start');
  await settle();
  expect(h.complete).toHaveBeenCalledWith(
    mode === 'usable' ? h.preferred : h.ctx.model,
    expect.any(Object),
    expect.any(Object),
  );
  expect(h.setSessionName).toHaveBeenCalledWith('Generated title');
});

it('keeps heuristic naming when no current or available preferred model exists', async () => {
  const h = await harness('unavailable');
  h.ctx.model = undefined;
  h.fire('before_agent_start');
  await settle();
  expect(h.complete).not.toHaveBeenCalled();
  expect(h.setSessionName).toHaveBeenCalled();
});

it('does not retry a failed title request on the session model', async () => {
  const h = await harness('usable');
  h.complete.mockRejectedValueOnce(new Error('request failed'));
  h.fire('before_agent_start');
  await settle();
  expect(h.complete).toHaveBeenCalledTimes(1);
  expect(h.complete).toHaveBeenCalledWith(h.preferred, expect.any(Object), expect.any(Object));
  expect(h.setSessionName).toHaveBeenCalled(); // Existing heuristic fallback.
});

it.each(['selection', 'auth'])('shutdown cancels pending %s before completion', async (stage) => {
  const h = await harness('usable');
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (stage === 'selection')
    h.getAvailableOfType.mockImplementation(async () => {
      await pending;
      return [h.preferred];
    });
  else
    h.getApiKeyAndHeaders.mockImplementation(async () => {
      await pending;
      return { ok: true };
    });
  h.fire('before_agent_start');
  await settle();
  h.fire('session_shutdown');
  release();
  await settle();
  expect(h.complete).not.toHaveBeenCalled();
  expect(h.setSessionName).not.toHaveBeenCalled();
  const options = h.getAvailableOfType.mock.calls[0] as unknown as [string, string, { signal: AbortSignal }];
  expect(options[2].signal.aborted).toBe(true);
});

it('waits for a prompt that states a task before naming', async () => {
  const h = await harness('usable');
  for (const prompt of ['ok', 'hello', 'hi there']) h.fire('before_agent_start', prompt);
  await settle();
  expect(h.complete).not.toHaveBeenCalled();
  expect(h.setSessionName).not.toHaveBeenCalled();

  h.fire('before_agent_start', 'Fix the flaky login test');
  await settle();
  expect(h.setSessionName).toHaveBeenCalledWith('Generated title');
});

it('strips markdown and control characters from LLM titles', async () => {
  const h = await harness('usable');
  h.complete.mockResolvedValueOnce({
    stopReason: 'stop',
    content: [{ type: 'text', text: '## **Critique of the\x1b]0;x\x07 opening turn**' }],
  });
  h.fire('before_agent_start');
  await settle();
  expect(h.setSessionName).toHaveBeenCalledWith('Critique of the ]0;x opening turn');
});
