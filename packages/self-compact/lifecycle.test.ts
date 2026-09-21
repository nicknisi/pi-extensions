import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uuidv7 } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext, SessionEntry, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import extension, {
  MAX_NOTE_LENGTH,
  STATE_ENTRY,
  TOOL_NAME,
  readHandoffState,
  validateNote,
  type HandoffState,
} from './extensions/self-compact/self-compact.js';

const BOUNDARY = join(dirname(fileURLToPath(import.meta.url)), 'verify', 'boundary.mjs');

interface Harness {
  call(note: unknown): Promise<unknown>;
  entries: SessionEntry[];
  appended: Array<{ type: string; data: unknown }>;
  active(): string[];
  state(): HandoffState | undefined;
  setAppendThrow(value: boolean): void;
}

function makeHarness(initialActive = ['read', 'bash', 'edit', 'write', TOOL_NAME]): Harness {
  const entries: SessionEntry[] = [];
  const appended: Array<{ type: string; data: unknown }> = [];
  let active = [...initialActive];
  let appendThrows = false;
  const tools = new Map<string, ToolDefinition>();

  const pi = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    on: () => () => {},
    registerCommand: () => {},
    appendEntry: (type: string, data: unknown) => {
      if (appendThrows) throw new Error('simulated persistence failure (disk full)');
      appended.push({ type, data });
      entries.push({
        type: 'custom',
        customType: type,
        data,
        id: uuidv7(),
        parentId: null,
        timestamp: new Date().toISOString(),
      } as unknown as SessionEntry);
    },
    getAllTools: () => initialActive.map((name) => ({ name })),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = [...names];
    },
    sendMessage: () => {},
  } as unknown as ExtensionAPI;

  extension(pi);

  const ctx = {
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => 'session-1',
      getSessionFile: () => undefined,
    },
    isIdle: () => true,
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;

  const tool = tools.get(TOOL_NAME);
  if (!tool) throw new Error('self_compact tool was not registered');

  return {
    call: (note: unknown) => tool.execute('call-1', { note_to_self: note }, undefined, undefined, ctx),
    entries,
    appended,
    active: () => active,
    state: () => readHandoffState(entries),
    setAppendThrow: (value: boolean) => {
      appendThrows = value;
    },
  };
}

describe('note validation', () => {
  it('rejects a blank note without changing state', async () => {
    const h = makeHarness();
    await expect(h.call('')).rejects.toThrow(/blank/);
    expect(h.state()).toBeUndefined();
    expect(h.appended).toHaveLength(0);
  });

  it('rejects a whitespace-only note', async () => {
    const h = makeHarness();
    await expect(h.call('   \n\t  ')).rejects.toThrow(/blank/);
    expect(h.state()).toBeUndefined();
  });

  it('accepts a note of exactly 24,000 characters', async () => {
    const h = makeHarness();
    const note = 'a'.repeat(MAX_NOTE_LENGTH);
    await expect(h.call(note)).resolves.toBeTruthy();
    expect(h.state()?.note).toBe(note);
  });

  it('rejects a note of 24,001 characters without changing state', async () => {
    const h = makeHarness();
    const note = 'a'.repeat(MAX_NOTE_LENGTH + 1);
    await expect(h.call(note)).rejects.toThrow(/at most 24000/);
    expect(h.state()).toBeUndefined();
  });

  it('preserves leading and trailing whitespace verbatim', async () => {
    const h = makeHarness();
    const note = '   keep me\n  indented next action  ';
    await h.call(note);
    expect(h.state()?.note).toBe(note);
  });

  it('preserves multiline Unicode content verbatim', async () => {
    const h = makeHarness();
    const note = 'résumé étape 1 → 完了\n第二段階: fix café\n🚀 ship';
    await h.call(note);
    expect(h.state()?.note).toBe(note);
  });

  it('uses JS string-length semantics for the boundary (validateNote)', () => {
    expect(validateNote('a'.repeat(MAX_NOTE_LENGTH)).ok).toBe(true);
    expect(validateNote('a'.repeat(MAX_NOTE_LENGTH + 1)).ok).toBe(false);
    // An astral character is length 2 in JS string units.
    expect('🚀'.length).toBe(2);
    expect(validateNote('🚀'.repeat(MAX_NOTE_LENGTH / 2)).ok).toBe(true);
    expect(validateNote('🚀'.repeat(MAX_NOTE_LENGTH / 2 + 1)).ok).toBe(false);
  });

  it('reports persistence failure as failure without recording success', async () => {
    const h = makeHarness();
    h.setAppendThrow(true);
    await expect(h.call('do the thing')).rejects.toThrow(/persistence failure/);
    expect(h.state()).toBeUndefined();
    expect(h.appended).toHaveLength(0);
  });

  it('is idempotent on a duplicate call with the same note (retry)', async () => {
    const h = makeHarness();
    await h.call('same note');
    const first = h.state();
    await h.call('same note');
    const second = h.state();
    expect(second?.cycleId).toBe(first?.cycleId);
    // No second state entry appended for the idempotent retry.
    expect(h.appended.filter((a) => a.type === STATE_ENTRY)).toHaveLength(1);
  });

  it('rejects replacing a pending handoff with a different note', async () => {
    const h = makeHarness();
    await h.call('first note');
    await expect(h.call('different note')).rejects.toThrow(/different self_compact handoff/i);
    expect(h.state()?.note).toBe('first note');
  });
});

describe('handoff reservation', () => {
  it('captures the prior active-tool selection once and locks to self_compact', async () => {
    const h = makeHarness(['read', 'bash', 'edit', 'write', TOOL_NAME]);
    await h.call('checkpoint');
    expect(h.state()?.originalActiveTools).toEqual(['read', 'bash', 'edit', 'write']);
    expect(h.active()).toEqual([TOOL_NAME]);
  });

  it('does not overwrite the original snapshot on retry after the lock', async () => {
    const h = makeHarness(['read', 'bash', TOOL_NAME]);
    await h.call('checkpoint');
    // Locked now; a retry must keep the original (unlocked) snapshot.
    await h.call('checkpoint');
    expect(h.state()?.originalActiveTools).toEqual(['read', 'bash']);
  });
});

describe('boundary helper', () => {
  let repo: string;
  let baseline: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'self-compact-boundary-'));
    baseline = join(mkdtempSync(join(tmpdir(), 'self-compact-baseline-')), 'baseline.json');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    mkdirSync(join(repo, 'other'), { recursive: true });
    mkdirSync(join(repo, 'packages', 'self-compact'), { recursive: true });
    writeFileSync(join(repo, 'other', 'keep.txt'), 'unrelated\n');
    writeFileSync(join(repo, 'dirty.txt'), 'pre-existing dirty\n');
    writeFileSync(join(repo, 'packages', 'self-compact', 'a.txt'), 'owned\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const run = (command: string) => {
    try {
      execFileSync('node', [BOUNDARY, command], {
        env: { ...process.env, SELF_COMPACT_BOUNDARY_ROOT: repo, SELF_COMPACT_BOUNDARY_BASELINE: baseline },
        stdio: 'pipe',
      });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? 1;
    }
  };

  it('fails check when the baseline is missing', () => {
    expect(run('check')).not.toBe(0);
  });

  it('passes check immediately after capture', () => {
    expect(run('capture')).toBe(0);
    expect(run('check')).toBe(0);
  });

  it('detects a modified unrelated file', () => {
    run('capture');
    writeFileSync(join(repo, 'other', 'keep.txt'), 'tampered\n');
    expect(run('check')).not.toBe(0);
  });

  it('detects an added unrelated file', () => {
    run('capture');
    writeFileSync(join(repo, 'other', 'new.txt'), 'sneaked in\n');
    expect(run('check')).not.toBe(0);
  });

  it('detects a modified pre-existing dirty file', () => {
    run('capture');
    writeFileSync(join(repo, 'dirty.txt'), 'changed\n');
    expect(run('check')).not.toBe(0);
  });

  it('ignores changes inside the approved package path', () => {
    run('capture');
    writeFileSync(join(repo, 'packages', 'self-compact', 'a.txt'), 'edited freely\n');
    writeFileSync(join(repo, 'packages', 'self-compact', 'b.txt'), 'new owned file\n');
    expect(run('check')).toBe(0);
  });

  it('refuses to overwrite an existing baseline', () => {
    expect(run('capture')).toBe(0);
    expect(run('capture')).not.toBe(0);
  });
});
