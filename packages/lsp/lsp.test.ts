import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client, capabilities, serverRequest } from './client.js';
import { Service, bounded } from './index.js';
import { documentText, projectFile, type Config } from './project.js';
vi.mock('./project.js', async (original) => ({
  ...(await original<typeof import('./project.js')>()),
  loadConfig: async () => config,
}));
const dirs: string[] = [];
const clients: Client[] = [];
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-lsp-')));
  dirs.push(root);
  const file = join(root, 'main.ts');
  await writeFile(file, 'export const value = 1;\nvalue;\n');
  return { root, file };
}
const server = '/Users/nicknisi/.pi/agent/language-servers/typescript-lsp/node_modules/.bin/typescript-language-server';
const tsserver = '/Users/nicknisi/.pi/agent/language-servers/typescript-lsp/node_modules/typescript/lib/tsserver.js';
const config: Config = {
  command: server,
  args: ['--stdio'],
  timeoutMs: 10000,
  initializationOptions: { tsserver: { path: tsserver } },
};
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(clients.splice(0).map((client) => client.shutdown()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
describe('read-only boundary', () => {
  it('reads configuration from the selected global agent directory', async () => {
    const { root } = await fixture();
    vi.stubEnv('PI_CODING_AGENT_DIR', root);
    await mkdir(join(root, 'configs'));
    await writeFile(join(root, 'configs/lsp.json'), JSON.stringify({ timeoutMs: 4321 }));
    const actual = await vi.importActual<typeof import('./project.js')>('./project.js');
    expect(await actual.loadConfig()).toMatchObject({ command: 'typescript-language-server', timeoutMs: 4321 });
  });
  it('advertises no edits and rejects requests without touching files', async () => {
    const { file } = await fixture();
    const before = await readFile(file, 'utf8');
    expect(capabilities.workspace.applyEdit).toBe(false);
    expect(serverRequest('workspace/applyEdit')).toEqual({
      applied: false,
      failureReason: 'Read-only lsp tool never applies workspace edits.',
    });
    expect(() => serverRequest('workspace/executeCommand')).toThrow('does not support');
    expect(await readFile(file, 'utf8')).toBe(before);
  });
  it('untrusted context never even accesses cwd or project/config/spawn', async () => {
    const service = new Service();
    const ctx = {
      get cwd(): string {
        throw new Error('cwd must not be read');
      },
      isProjectTrusted: () => false,
    };
    await expect(service.execute({ action: 'symbols', file: 'main.ts' }, ctx)).rejects.toThrow('LSP_UNTRUSTED');
    await expect(service.execute({ action: 'symbols', file: 'main.ts' }, { cwd: '/nonexistent' })).rejects.toThrow(
      'LSP_UNTRUSTED',
    );
    await service.shutdown();
  });
  it('rejects traversal, sibling-prefix escapes, and symlinks outside root', async () => {
    const { root, file } = await fixture();
    const other = await fixture();
    await symlink(other.file, join(root, 'link.ts'));
    await expect(projectFile(root, '../main.ts')).rejects.toThrow('LSP_PATH');
    await expect(projectFile(root, `${root}-other/main.ts`)).rejects.toThrow('LSP_PATH');
    await expect(projectFile(root, 'link.ts')).rejects.toThrow('LSP_PATH');
    expect(await projectFile(root, 'main.ts')).toBe(await projectFile(root, file));
  });
  it('bounds large model-readable results', () => {
    const result = bounded({ text: 'x'.repeat(50000), position: { line: 0, character: 0 } });
    expect(result.length).toBeLessThan(24200);
    expect(result).toContain('truncated');
  });
});
describe('protocol lifecycle', () => {
  it('reports spawn failure distinctly', async () => {
    const { root } = await fixture();
    const client = new Client(root, '/missing/pi-lsp-server', config);
    clients.push(client);
    await expect(client.initialize()).rejects.toThrow('LSP_PROCESS');
  });
  it('reports process exit rather than waiting for timeout', async () => {
    const { root } = await fixture();
    const client = new Client(root, process.execPath, { ...config, args: ['-e', 'process.exit(12)'] });
    clients.push(client);
    await expect(client.initialize()).rejects.toThrow('LSP_PROCESS');
  });
  it('sends cancellation and distinguishes timeout and abort', async () => {
    const { root } = await fixture();
    const rpc = new URL('./node_modules/vscode-jsonrpc/node.js', import.meta.url).pathname;
    const script = `const rpc = require(${JSON.stringify(rpc)}); const c = rpc.createMessageConnection(new rpc.StreamMessageReader(process.stdin),new rpc.StreamMessageWriter(process.stdout)); c.onRequest('wait',(_,token)=>new Promise(resolve=>token.onCancellationRequested(()=>{c.sendNotification('cancelled');resolve(null)})));c.listen();`;
    const client = new Client(root, process.execPath, { ...config, args: ['-e', script] });
    clients.push(client);
    let cancellations = 0;
    client.connection.onNotification('cancelled', () => {
      cancellations++;
    });
    const controller = new AbortController();
    const pending = client.request('wait', {}, controller.signal);
    setTimeout(() => controller.abort(), 250);
    await expect(pending).rejects.toThrow('LSP_CANCELLED');
    await expect(client.request('wait', {}, undefined, 200)).rejects.toThrow('LSP_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(cancellations).toBe(2);
  });
});
const real = process.env.PI_LSP_REAL_TEST === '1' ? it : it.skip;
real(
  'service refreshes external edits on every call and shuts down',
  async () => {
    const { root, file } = await fixture();
    const service = new Service();
    const ctx = { cwd: root, isProjectTrusted: () => true };
    try {
      const input = { action: 'hover' as const, file, line: 2, column: 2 };
      expect(await service.execute(input, ctx)).toContain('1');
      await writeFile(file, 'export const value = "service-changed";\nvalue;\n');
      expect(await service.execute(input, ctx)).toContain('service-changed');
      await service.shutdown();
      await expect(service.execute(input, ctx)).rejects.toThrow('LSP_SHUTDOWN');
    } finally {
      await service.shutdown();
    }
  },
  30000,
);
real(
  'real TS server: definition/references/hover/symbols, external edits, fresh diagnostics',
  async () => {
    const { root, file } = await fixture();
    await mkdir(join(root, 'src'));
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }),
    );
    const client = new Client(root, server, config);
    clients.push(client);
    await client.initialize();
    await client.sync(file, await documentText(root, file));
    const uri = pathToFileURL(file).href;
    const textDocument = { uri };
    const position = { line: 1, character: 1 };
    expect(await client.request('textDocument/definition', { textDocument, position })).toBeTruthy();
    expect(
      await client.request('textDocument/references', {
        textDocument,
        position,
        context: { includeDeclaration: true },
      }),
    ).toBeTruthy();
    expect(await client.request('textDocument/documentSymbol', { textDocument })).toBeTruthy();
    expect(JSON.stringify(await client.request('textDocument/hover', { textDocument, position }))).toContain('1');
    await writeFile(file, 'export const value = "changed";\nvalue;\n');
    await client.sync(file, await documentText(root, file));
    expect(JSON.stringify(await client.request('textDocument/hover', { textDocument, position }))).toContain('changed');
    await writeFile(file, 'export const value: number = "bad";\nvalue;\n');
    await client.sync(file, await documentText(root, file), true);
    expect(JSON.stringify(await client.collectDiagnostics(uri))).toContain('2322');
  },
  30000,
);
