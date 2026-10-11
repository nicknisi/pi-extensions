/**
 * The subagent runtime inside a host that supplies its own model provider and
 * file locations (e.g. Riker's coding workers):
 * - children reuse the parent's model registry, so a provider registered on
 *   the parent at runtime (header-only auth, like a Cloudflare AI Gateway
 *   worker) carries its headers into the child's request, with no provider key;
 * - PI_SUBAGENTS_DIR moves every file the runtime writes under one root.
 *
 * Everything stays on loopback: a stub OpenAI-compatible server on
 * 127.0.0.1:0 and a temp PI_CODING_AGENT_DIR so no user auth/models load.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Api, Model, Provider } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subagentsDir } from './subagents-dir.js';
import { createSubagentRuntime, parentModelRuntime, writeSessionMirror } from './subagents.js';
import { runWorkflow } from './workflow.js';
import { addWorktree, removeWorktree } from './worktree.js';

const PROVIDER = 'stub-gateway';

interface Captured {
  url: string;
  headers: http.IncomingHttpHeaders;
  model: string;
}

/**
 * Minimal OpenAI chat-completions SSE stub that records each request. When
 * the request offers a `write` tool and no tool result is in the history yet,
 * it answers with one `write` call (child.txt); otherwise with text.
 */
function startStub(): Promise<{ server: http.Server; baseUrl: string; requests: Captured[] }> {
  const requests: Captured[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let parsed: { model?: string; tools?: { function?: { name?: string } }[]; messages?: { role?: string }[] } = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        // non-JSON body; record what we can
      }
      const model = parsed.model ?? '';
      requests.push({ url: req.url ?? '', headers: req.headers, model });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const offersWrite = parsed.tools?.some((t) => t.function?.name === 'write');
      const hasToolResult = parsed.messages?.some((m) => m.role === 'tool');
      if (offersWrite && !hasToolResult) {
        const args = JSON.stringify({ path: 'child.txt', content: 'from the child\n' });
        const call = { index: 0, id: 'call_1', type: 'function', function: { name: 'write', arguments: args } };
        res.write(chunk({ role: 'assistant', tool_calls: [call] }, null));
        res.write(chunk({}, 'tool_calls'));
      } else {
        res.write(chunk({ role: 'assistant', content: 'stub reply' }, null));
        res.write(chunk({}, 'stop'));
      }
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, requests });
    });
  });
}

let stub: Awaited<ReturnType<typeof startStub>>;
let agentDir: string;
let prevAgentDir: string | undefined;

beforeEach(async () => {
  prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagents-registry-'));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  stub = await startStub();
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    stub.server.closeAllConnections();
    stub.server.close(() => resolve());
  });
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  fs.rmSync(agentDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * A parent registry with a gateway provider registered at runtime, the way
 * Riker's worker extension does it: pi's built-in Cloudflare AI Gateway
 * provider, re-registered with an in-memory credential (no key on disk or in
 * env), here under its own id and pointed at the loopback stub.
 */
async function parentRegistry(): Promise<{ registry: ModelRegistry; model: Model<Api> }> {
  const registry = new ModelRegistry(await ModelRuntime.create());
  const builtin = registry.getProvider('cloudflare-ai-gateway');
  if (!builtin?.auth.apiKey) throw new Error('pi-ai no longer ships the cloudflare-ai-gateway provider');
  const apiKey = builtin.auth.apiKey;
  const credential = {
    type: 'api_key' as const,
    key: 'test-token',
    env: { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_GATEWAY_ID: 'gw' },
  };
  const models = builtin
    .getModels()
    .filter((m) => m.api === 'openai-completions')
    .slice(0, 2)
    .map((m) => ({
      ...m,
      provider: PROVIDER,
      baseUrl: m.baseUrl.replace('https://gateway.ai.cloudflare.com/v1', stub.baseUrl),
    }));
  if (models.length < 2) throw new Error('expected two openai-completions gateway models');
  const provider: Provider = {
    ...builtin,
    id: PROVIDER,
    auth: { apiKey: { name: apiKey.name, resolve: (input) => apiKey.resolve({ ...input, credential }) } },
    getModels: () => models,
  };
  registry.registerProvider(provider);
  return { registry, model: models[0]! };
}

function expectGatewayRequest(req: Captured | undefined, model: Model<Api>): void {
  expect(req).toBeDefined();
  expect(req!.url).toBe('/acct/gw/compat/chat/completions');
  expect(req!.model).toBe(model.id);
  expect(req!.headers['cf-aig-authorization']).toBe('Bearer test-token');
  expect(req!.headers.authorization).toBeUndefined();
  expect(req!.headers['x-api-key']).toBeUndefined();
}

function spawnChild(registry: ModelRegistry, parentModel: Model<Api>, model?: string) {
  const parent = { modelRegistry: registry, model: parentModel };
  const runtime = createSubagentRuntime({ namespace: 'registry-test', parent: () => parent });
  return runtime.spawn({ prompt: 'hi', tools: [], timeoutMs: 10_000, ...(model ? { model } : {}) });
}

describe('children reuse the parent model registry', () => {
  it("returns the parent registry's own runtime (fails loudly if pi renames the private field)", async () => {
    const runtime = await ModelRuntime.create();
    expect(await parentModelRuntime(new ModelRegistry(runtime))).toBe(runtime);
  });

  it("defaults to the parent's model and sends the gateway header, no provider key", { timeout: 15_000 }, async () => {
    const { registry, model } = await parentRegistry();
    const result = await spawnChild(registry, model);
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(result.text).toBe('stub reply');
    expect(stub.requests).toHaveLength(1);
    expectGatewayRequest(stub.requests[0], model);
  });

  it('resolves an explicit model on the runtime-registered provider', { timeout: 15_000 }, async () => {
    const { registry, model } = await parentRegistry();
    const other = registry.getAll().find((m) => m.provider === PROVIDER && m.id !== model.id)!;
    const result = await spawnChild(registry, model, `${PROVIDER}/${other.id}`);
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expectGatewayRequest(stub.requests[0], other);
  });

  it('replays runtime-registered providers when the private field is missing', { timeout: 15_000 }, async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { registry, model } = await parentRegistry();
    // Simulate a pi upgrade that renames the private field: the public API still works.
    const renamed = new Proxy(registry, {
      get(target, prop) {
        if (prop === 'runtime') return undefined;
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const result = await spawnChild(renamed, model);
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expectGatewayRequest(stub.requests[0], model);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unavailable', () => undefined],
    [
      'stale',
      () => {
        throw new Error('ctx is stale');
      },
    ],
  ])('fails closed when the configured parent context is %s', async (state, parent) => {
    const runtime = createSubagentRuntime({ namespace: 'registry-test', parent });
    const result = await runtime.spawn({ prompt: 'hi', tools: [], timeoutMs: 10_000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('crashed');
    expect(result.error).toContain(`parent session context is ${state}`);
    expect(stub.requests).toHaveLength(0);
  });

  it(
    'without a parent, an unknown runtime-only provider fails (no silent fallback to it)',
    { timeout: 15_000 },
    async () => {
      const runtime = createSubagentRuntime({ namespace: 'registry-test' });
      const result = await runtime.spawn({ prompt: 'hi', tools: [], model: `${PROVIDER}/x`, timeoutMs: 10_000 });
      expect(result.ok).toBe(false);
      expect(stub.requests).toHaveLength(0);
    },
  );
});

/** Every file (not dir) under root, relative to it. */
function filesUnder(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return (fs.readdirSync(root, { recursive: true }) as string[])
    .filter((rel) => fs.statSync(path.join(root, rel)).isFile())
    .sort();
}

function gitRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagents-repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', timeout: 10_000 });
  git('init', '-q');
  git('-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '-q', '--allow-empty', '-m', 'init');
  return repo;
}

describe('PI_SUBAGENTS_DIR', () => {
  let root: string;
  let repo: string;
  const worktrees: string[] = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagents-root-'));
    repo = gitRepo();
  });

  afterEach(() => {
    delete process.env.PI_SUBAGENTS_DIR;
    for (const wt of worktrees.splice(0)) removeWorktree(repo, wt);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('puts every file a worktree child and a workflow write under the root', { timeout: 30_000 }, async () => {
    process.env.PI_SUBAGENTS_DIR = root;
    const { registry, model } = await parentRegistry();
    const before = filesUnder(agentDir);
    const runtime = createSubagentRuntime({
      namespace: 'files-test',
      artifactsDir: subagentsDir('runs')!, // as the extensions resolve it
      parent: () => ({ modelRegistry: registry, model }),
    });

    const result = await runtime.spawn({
      prompt: 'write child.txt',
      cwd: repo,
      tools: ['write'],
      worktree: true,
      parentSession: path.join(repo, 'parent.jsonl'),
      timeoutMs: 10_000,
    });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    const run = runtime.listRuns()[0]!;
    if (run.worktree?.path) worktrees.push(run.worktree.path);

    const workflow = await runWorkflow({ name: 'wf', stages: [{ id: 'only', prompt: 'hi', tools: [] }] }, runtime, {
      cwd: repo,
    });
    expect(workflow.ok).toBe(true);

    const id = result.runId;
    expect(run.worktree?.path).toBe(path.join(root, 'worktrees', id));
    expect(run.worktree?.patchPath).toBe(path.join(root, 'runs', 'files-test', `${id}.patch`));
    expect(run.sessionFile?.startsWith(path.join(root, 'sessions') + path.sep)).toBe(true);
    expect(workflow.runDir.startsWith(path.join(root, 'workflow-runs') + path.sep)).toBe(true);

    const written = filesUnder(root);
    expect(written).toContain(path.join('runs', 'files-test', `${id}.json`));
    expect(written).toContain(path.join('runs', 'files-test', `${id}.patch`));
    expect(written).toContain(path.join('worktrees', id, 'child.txt'));
    expect(written.some((f) => f.startsWith(`sessions${path.sep}`) && f.endsWith('.jsonl'))).toBe(true);
    expect(written.some((f) => f.startsWith(`workflow-runs${path.sep}`) && f.endsWith('status.json'))).toBe(true);
    // Nothing the runtime wrote landed in the agent dir, nor in the caller's tree.
    expect(filesUnder(agentDir)).toEqual(before);
    expect(fs.existsSync(path.join(repo, 'child.txt'))).toBe(false);
  });

  it('without the override, keeps the usual places under the agent dir', { timeout: 15_000 }, () => {
    delete process.env.PI_SUBAGENTS_DIR;
    expect(subagentsDir('runs')).toBeUndefined();

    const added = addWorktree(repo, 'default-run');
    if (!('path' in added)) throw new Error(added.error);
    worktrees.push(added.path);
    expect(added.path).toBe(path.join(agentDir, 'subagent-worktrees', 'default-run'));

    const file = writeSessionMirror(
      [
        { role: 'user', content: 'hi', timestamp: 1 },
        { role: 'assistant', content: [{ type: 'text', text: 'yo' }], stopReason: 'stop', timestamp: 2 },
      ],
      repo,
      undefined,
    );
    expect(file?.startsWith(path.join(agentDir, 'sessions') + path.sep)).toBe(true);
    expect(filesUnder(root)).toEqual([]);
  });
});
