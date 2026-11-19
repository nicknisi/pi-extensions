import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// pi isn't importable: only a bindPiSdk() binding can supply it.
vi.mock('@earendil-works/pi-coding-agent', () => {
  throw new Error('pi not installed');
});

import { bindPiSdk, createSubagentRuntime, readRunArtifacts, type PiSdk } from './subagents.js';

describe('pi SDK binding', () => {
  let artifactsDir: string;
  const saved = { depth: process.env.PI_SUBAGENT_DEPTH, child: process.env.PI_SUBAGENT_CHILD };

  beforeEach(() => {
    artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sdk-test-'));
    delete process.env.PI_SUBAGENT_DEPTH;
    delete process.env.PI_SUBAGENT_CHILD;
  });

  afterEach(() => {
    fs.rmSync(artifactsDir, { recursive: true, force: true });
    if (saved.depth !== undefined) process.env.PI_SUBAGENT_DEPTH = saved.depth;
    if (saved.child !== undefined) process.env.PI_SUBAGENT_CHILD = saved.child;
  });

  // Runs first: nothing is bound yet.
  it('fails the run, and persists it as failed, when unbound and pi cannot be imported', async () => {
    const result = await createSubagentRuntime({ namespace: 'sdk-unbound', artifactsDir }).spawn({ prompt: 'hi' });
    expect(result).toMatchObject({ ok: false, kind: 'crashed' });
    expect(result.ok ? '' : result.error).toContain('Cannot load pi');
    expect(readRunArtifacts(artifactsDir)).toMatchObject([{ status: 'failed' }]);
  });

  it('uses the bound SDK instead of importing pi', async () => {
    const resolveCliModel = vi.fn(() => ({ error: 'bound sdk used' }));
    bindPiSdk({
      SessionManager: { inMemory: () => ({}) },
      ModelRuntime: { create: async () => ({}) },
      resolveCliModel,
    } as unknown as PiSdk);
    const result = await createSubagentRuntime({ namespace: 'sdk-bound', artifactsDir }).spawn({
      prompt: 'hi',
      model: 'any/model',
    });
    expect(result).toMatchObject({ ok: false, kind: 'crashed', error: 'bound sdk used' });
    expect(resolveCliModel).toHaveBeenCalledOnce();
  });
});
