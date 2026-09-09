import { describe, expect, it } from 'vitest';
import { Script } from 'node:vm';
import { annotateSnippet } from './annotate.js';

const source = annotateSnippet('test', '[]');
const clean = source.slice(source.indexOf('  function clean(a)'), source.indexOf('  // Each request snapshots'));
const merge = source.slice(source.indexOf('  function mergeServer('), source.indexOf('  // ── anchoring / highlights'));
const record = (id: string, comment = id) => ({ id, comment, createdAt: '2026-09-09' });

function harness(baseline: unknown[], local: unknown[]) {
  const state = { annotations: local, baseline, revision: 'old', conflict: false, saveError: false };
  const reconcile = new Function(
    'state',
    'showToast',
    'reHighlightAll',
    'render',
    `${clean}\n${merge}\nreturn mergeServer;`,
  )(
    state,
    () => {},
    () => {},
    () => {},
  );
  return { state, reconcile };
}

describe('emitted browser review logic', () => {
  it('produces valid JavaScript in both live and offline modes', () => {
    for (const options of [{}, { static: true, revision: 'v1' }]) {
      const script = annotateSnippet('test', '[]', options).match(/<script>([\s\S]*)<\/script>/)?.[1];
      expect(script).toBeTruthy();
      expect(() => new Script(script!)).not.toThrow();
    }
  });
  it('keeps the composer in the panel and does not clear it when the panel closes', () => {
    expect(source).toContain('panel.querySelector(".composer-slot").appendChild(popover)');
    const state = { mode: 'annotate', pending: { exact: 'original passage' } };
    const setMode = new Function(
      'state',
      'btn',
      'setPinning',
      'render',
      `${source.slice(source.indexOf('  function setMode('), source.indexOf('  // ── persistence'))}\nreturn setMode;`,
    )(
      state,
      { classList: { toggle() {} }, focus() {} },
      () => {},
      () => {},
    );
    setMode('off');
    expect(state.mode).toBe('off');
    expect(state.pending).toEqual({ exact: 'original passage' });
  });
  it('refuses to silently retarget a comment that is already being written', () => {
    const state = { pending: {} };
    let message = '';
    const open = new Function(
      'state',
      'popTextarea',
      'showToast',
      `${source.slice(source.indexOf('  function openComposer('), source.indexOf('  function elementSelector('))}\nreturn openComposer;`,
    )(state, { value: 'An existing whole-document comment' }, (text: string) => {
      message = text;
    });
    open({ exact: 'another passage' });
    expect(state.pending).toEqual({});
    expect(message).toContain('Add or clear');
  });
  it('includes typed feedback before sending, but refuses sends during an inline edit', async () => {
    const state = {
      editing: null as number | null,
      sending: false,
      annotations: [] as { sentAt?: string }[],
      saveError: true,
      saving: Promise.resolve(),
    };
    const calls: string[] = [];
    const send = new Function(
      'STATIC',
      'state',
      'popTextarea',
      'addPending',
      'render',
      'persist',
      'sendBtn',
      'showToast',
      `${source.slice(source.indexOf('  function send()'), source.indexOf('  function showFeedbackFallback('))}\nreturn send;`,
    )(
      false,
      state,
      { value: 'Ready to send' },
      () => {
        calls.push('add');
        state.annotations.push({});
      },
      () => {},
      () => {
        calls.push('persist');
        return Promise.resolve();
      },
      { disabled: true },
      () => {},
    );
    state.editing = 0;
    send();
    expect(calls).toEqual([]);
    state.editing = null;
    send();
    expect(calls).toEqual(['add', 'persist']);
    await state.saving;
    expect(state.sending).toBe(false);
    expect(state.annotations).toHaveLength(1);
  });
  it('retains both a local draft and another tab’s new draft when an answer arrives', () => {
    const sent = { ...record('q'), intent: 'question', sentAt: 'sent' };
    const { state, reconcile } = harness([sent], [sent, record('local')]);
    reconcile([{ ...sent, reply: 'answer' }, record('remote')], 'new');
    expect(state.annotations).toEqual([{ ...sent, reply: 'answer' }, record('local'), record('remote')]);
    expect(state.revision).toBe('new');
  });
  it('lets sent records supersede drafts without duplicates', () => {
    const draft = record('a');
    const { state, reconcile } = harness([draft], [draft]);
    reconcile([{ ...draft, sentAt: 'sent' }], 'new');
    expect(state.annotations).toEqual([{ ...draft, sentAt: 'sent' }]);
  });
  it('keeps a newer local edit when a previous save completes', () => {
    const old = record('a', 'old'),
      saved = record('a', 'saved'),
      newer = record('a', 'newer');
    const { state, reconcile } = harness([old], [newer]);
    reconcile([saved], 'new', [saved]);
    expect(state.annotations).toEqual([newer]);
    expect(state.baseline).toEqual([saved]);
  });
  it('refuses conflicting edits without advancing the token or deleting local text', () => {
    const old = record('a', 'old'),
      local = record('a', 'local'),
      remote = record('a', 'remote');
    const { state, reconcile } = harness([old], [local]);
    reconcile([remote], 'new');
    expect(state.conflict).toBe(true);
    expect(state.saveError).toBe(true);
    expect(state.revision).toBe('old');
    expect(state.annotations).toEqual([local]);
  });
});
