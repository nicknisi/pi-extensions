import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import extension from './index.js';

const ok = { stdout: '', stderr: '', code: 0, killed: false };
let cwd: string;
let file: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'pi-ast-grep-test-'));
  file = join(cwd, 'sample.ts');
  await writeFile(file, 'console.log("hi");\n');
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function setup(result = ok) {
  const tools = new Map<string, ToolDefinition>();
  const exec = vi
    .fn<ExtensionAPI['exec']>()
    .mockImplementation(async (_command, args) =>
      args[0] === '--version' ? { ...ok, stdout: 'ast-grep 0.45.3' } : result,
    );
  extension({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), exec } as unknown as ExtensionAPI);
  const call = (name: string, params: Record<string, unknown>, signal?: AbortSignal) =>
    tools.get(name)!.execute('test', params, signal, undefined, { cwd } as ExtensionContext);
  return { tools, exec, call };
}
const rewrite = { pattern: 'console.log($MSG)', replacement: 'logger.debug($MSG)' };

describe('CLI safety', () => {
  it('registers underscore names and requires a rewrite path in the schema', () => {
    const { tools } = setup();
    expect([...tools.keys()]).toEqual(['ast_search', 'ast_rewrite']);
    expect(tools.get('ast_rewrite')!.parameters).toHaveProperty('required', expect.arrayContaining(['path']));
  });
  it('defaults to preview and keeps dangerous-looking arguments literal', async () => {
    const { call, exec } = setup();
    await call('ast_rewrite', { ...rewrite, path: file, pattern: '--update-all; $(touch nope)' });
    const [binary, args] = exec.mock.calls[1]!;
    expect(binary).toBe('ast-grep');
    expect(args).toContain('--pattern=--update-all; $(touch nope)');
    expect(args).not.toContain('--update-all');
    expect(args.slice(-2)).toEqual(['--', file]);
  });
  it('applies only explicit false and passes abort and timeout to both calls', async () => {
    const { call, exec } = setup();
    const signal = new AbortController().signal;
    await call('ast_rewrite', { ...rewrite, path: file, dryRun: false, timeout: 1234 }, signal);
    expect(exec.mock.calls[1]![1]).toContain('--update-all');
    for (const args of exec.mock.calls) expect(args[2]).toEqual({ cwd, signal, timeout: 1234 });
  });
  it('rejects missing, empty, and directory rewrite paths without invoking the CLI', async () => {
    const { call, exec } = setup();
    for (const path of [undefined, '', cwd]) {
      await expect(call('ast_rewrite', { ...rewrite, path })).rejects.toThrow(/file/);
    }
    expect(exec).not.toHaveBeenCalled();
  });
  it('recognizes empty exit 1 only after a successful version check', async () => {
    const { call, exec } = setup({ ...ok, code: 1 });
    expect((await call('ast_search', { pattern: 'absent' })).content).toEqual([
      { type: 'text', text: 'Search results.\nNo matches found.' },
    ]);
    exec.mockResolvedValue({ ...ok, code: 1 });
    await expect(call('ast_search', { pattern: 'absent' })).rejects.toThrow(/executable unavailable/);
  });
  it('reports diagnostics and nonzero exits as errors', async () => {
    for (const code of [1, 2, 127]) {
      const { call } = setup({ ...ok, code, stderr: 'bad pattern' });
      await expect(call('ast_search', { pattern: 'x' })).rejects.toThrow(/failed.*exit/);
    }
  });
  it('reports thrown missing binary, killed process, and pre-abort', async () => {
    const { call, exec } = setup();
    exec.mockRejectedValue(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await expect(call('ast_search', { pattern: 'x' })).rejects.toThrow(/not found/);
    const killed = setup({ ...ok, killed: true });
    await expect(killed.call('ast_rewrite', { ...rewrite, path: file, dryRun: false })).rejects.toThrow(
      /partially modified/,
    );
    const aborted = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(aborted.call('ast_search', { pattern: 'x' }, controller.signal)).rejects.toThrow();
    expect(aborted.exec).not.toHaveBeenCalled();
  });
  it('bounds results while retaining initial paths and line numbers', async () => {
    const { call } = setup({ ...ok, stdout: 'sample.ts:1:console.log("hi")\n' + 'sample.ts:2:x\n'.repeat(10000) });
    const result = await call('ast_search', { pattern: 'x' });
    const text = result.content[0];
    expect(text?.type).toBe('text');
    if (text?.type !== 'text') throw new Error('Expected text');
    expect(text.text).toContain('sample.ts:1:');
    expect(text.text).toContain('truncated');
    expect(Buffer.byteLength(text.text)).toBeLessThan(31000);
  });
});

it('real CLI searches, previews without writing, applies, and reports no matches', async (ctx) => {
  const exec = promisify(execFile);
  try {
    await exec('ast-grep', ['--version']);
  } catch {
    ctx.skip();
    return;
  }
  const harness = setup();
  harness.exec.mockImplementation(async (command, args, options) => {
    try {
      const output = await exec(command, args, {
        cwd: options?.cwd,
        timeout: options?.timeout,
        signal: options?.signal,
      });
      return { ...ok, ...output };
    } catch (error) {
      const failure = error as Error & { code: number; stdout: string; stderr: string; killed: boolean };
      return { stdout: failure.stdout, stderr: failure.stderr, code: failure.code, killed: failure.killed ?? false };
    }
  });
  const search = await harness.call('ast_search', { pattern: rewrite.pattern });
  expect(JSON.stringify(search.content)).toContain('sample.ts:1:');
  const preview = await harness.call('ast_rewrite', { ...rewrite, path: file });
  expect(JSON.stringify(preview.content)).toContain('logger.debug');
  expect(await readFile(file, 'utf8')).toBe('console.log("hi");\n');
  await harness.call('ast_rewrite', { ...rewrite, path: file, dryRun: false });
  expect(await readFile(file, 'utf8')).toBe('logger.debug("hi");\n');
  expect(JSON.stringify((await harness.call('ast_search', { pattern: rewrite.pattern })).content)).toContain(
    'No matches found',
  );
});
