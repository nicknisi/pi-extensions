/**
 * Extension wiring tests: drive the factory with a stub ExtensionAPI/ctx and
 * cover the no-UI foreground default, session_shutdown → session_start
 * relaunch (in the original run's directory), and status/stop id lookup.
 * Scripts here never call agent(), so no child session is spawned.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import workflows from './index.js';

type Handler = (event: unknown, ctx: unknown) => unknown;
type ToolResult = { content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> };
interface Tool {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<ToolResult>;
}
interface Message {
  customType: string;
  content: string;
}

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-wf-index-'));
  dirs.push(dir);
  return dir;
}

const savedEnv: Record<string, string | undefined> = {};
let subagentsRoot = '';
beforeEach(() => {
  for (const key of ['PI_CODING_AGENT_DIR', 'PI_SUBAGENTS_DIR']) savedEnv[key] = process.env[key];
  process.env.PI_CODING_AGENT_DIR = tmp();
  subagentsRoot = tmp();
  process.env.PI_SUBAGENTS_DIR = subagentsRoot;
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function loadExtension() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, Tool & { name: string }>();
  const commands = new Map<string, unknown>();
  const messages: Message[] = [];
  let active: string[] = [];
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    registerFlag: () => {},
    getFlag: () => undefined,
    getCommands: () => [...commands.keys()].map((name) => ({ name })),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => (active = names),
    getAllTools: () => [...tools.values()],
    sendMessage: (message: Message) => messages.push(message),
  };
  workflows(pi as unknown as ExtensionAPI);
  return {
    messages,
    tool: tools.get('workflow')!,
    async emit(event: string, ctx: unknown): Promise<void> {
      for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
    },
  };
}

function fakeCtx(opts: { hasUI: boolean; cwd: string; sessionFile?: string; confirm?: () => Promise<boolean> }) {
  const notes: string[] = [];
  return {
    notes,
    hasUI: opts.hasUI,
    cwd: opts.cwd,
    mode: opts.hasUI ? 'tui' : 'print',
    isProjectTrusted: () => false,
    sessionManager: { getSessionFile: () => opts.sessionFile },
    ui: {
      notify: (text: string) => notes.push(text),
      setStatus: () => {},
      setWidget: () => {},
      confirm: opts.confirm ?? (async () => true),
      select: async () => undefined,
    },
  };
}

async function waitFor<T>(get: () => T | undefined, ms = 2000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const runJson = (id: string) =>
  JSON.parse(fs.readFileSync(path.join(subagentsRoot, 'workflow-runs', id, 'run.json'), 'utf8')) as Record<
    string,
    unknown
  >;

describe('workflow tool wiring', () => {
  it('runs in the foreground by default without a UI', async () => {
    const ext = loadExtension();
    const ctx = fakeCtx({ hasUI: false, cwd: tmp() });
    await ext.emit('session_start', ctx);
    const res = await ext.tool.execute(
      't1',
      { action: 'run', script: "export const meta = { name: 'fg' };\nreturn 'value-' + args;", args: 7 },
      undefined,
      undefined,
      ctx,
    );
    expect(res.details.status).toBe('completed');
    expect(res.content[0]!.text).toContain('value-7');
    expect(ext.messages).toHaveLength(0);
  });

  it('runs in the background by default with a UI and delivers the result as a message', async () => {
    const ext = loadExtension();
    const ctx = fakeCtx({ hasUI: true, cwd: tmp() });
    await ext.emit('session_start', ctx);
    const res = await ext.tool.execute('t1', { action: 'run', script: "return 'bg-done';" }, undefined, undefined, ctx);
    expect(res.details.background).toBe(true);
    const msg = await waitFor(() => ext.messages.find((m) => m.customType === 'workflows:result'));
    expect(msg.content).toContain('bg-done');
  });

  it('status and stop resolve workflow ids, prefixes, and unknown agent run ids', async () => {
    const ext = loadExtension();
    const ctx = fakeCtx({ hasUI: false, cwd: tmp() });
    await ext.emit('session_start', ctx);
    const res = await ext.tool.execute('t1', { action: 'run', script: 'return 1;' }, undefined, undefined, ctx);
    const id = res.details.id as string;
    const call = (params: Record<string, unknown>) =>
      ext.tool.execute('t2', params, undefined, undefined, ctx).then((r) => r.content[0]!.text);

    expect(await call({ action: 'status', runId: id.slice(0, 6) })).toContain(`${id} inline`);
    expect(await call({ action: 'stop', runId: id })).toBe(`Workflow ${id} already completed.`);
    expect(await call({ action: 'status', runId: 'abcdef1234' })).toContain("No run 'abcdef1234'");
    expect(await call({ action: 'stop', runId: 'abcdef1234' })).toBe("No running workflow or agent 'abcdef1234'.");
    expect(await call({ action: 'stop' })).toBe('stop requires runId.');
  });
});

describe('session_shutdown → session_start relaunch', () => {
  const script = "export const meta = { name: 'gated' };\nawait checkpoint('hold');\nreturn 'ran in ' + cwd;";

  it('marks running workflows interrupted on shutdown and relaunches them in their original cwd', async () => {
    const sessionFile = path.join(tmp(), 'session.jsonl');
    const projectA = tmp();
    const first = loadExtension();
    // The checkpoint dialog never answers, so the run is still going at shutdown.
    const ctxA = fakeCtx({ hasUI: true, cwd: projectA, sessionFile, confirm: () => new Promise<boolean>(() => {}) });
    await first.emit('session_start', ctxA);
    const res = await first.tool.execute('t1', { action: 'run', script }, undefined, undefined, ctxA);
    const id = res.details.id as string;
    await waitFor(() => (runJson(id).status === 'running' ? true : undefined));

    await first.emit('session_shutdown', ctxA);
    expect(runJson(id)).toMatchObject({ status: 'stopped', interrupted: true, cwd: projectA });
    expect(first.messages).toHaveLength(0);

    // The session reopens in a different directory; the relaunch still works in projectA.
    const second = loadExtension();
    const ctxB = fakeCtx({ hasUI: true, cwd: tmp(), sessionFile });
    await second.emit('session_start', ctxB);
    expect(ctxB.notes.some((n) => n.startsWith('Relaunching 1 workflow'))).toBe(true);
    const msg = await waitFor(() => second.messages.find((m) => m.customType === 'workflows:result'));
    expect(msg.content).toContain('Resumed workflow');
    expect(msg.content).toContain(`ran in ${projectA}`);
  });

  it('refuses to relaunch a run whose directory is gone', async () => {
    const projectA = tmp();
    const ext = loadExtension();
    const ctx = fakeCtx({ hasUI: false, cwd: projectA });
    await ext.emit('session_start', ctx);
    const res = await ext.tool.execute('t1', { action: 'run', script: 'return 1;' }, undefined, undefined, ctx);
    const id = res.details.id as string;
    fs.rmSync(projectA, { recursive: true, force: true });
    const relaunch = await ext.tool.execute('t2', { action: 'run', relaunch: id }, undefined, undefined, ctx);
    expect(relaunch.content[0]!.text).toContain('no longer exists');
  });
});
