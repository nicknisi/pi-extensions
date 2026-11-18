import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASK_USER_ANSWER_EVENT } from './events.js';
import { askTool } from './test-utils/dialog.js';
import { useTempAgentDir } from './test-utils/index.js';

// Regression tests for upstream bugs fixed in this fork (CodeRabbit review of PR #238).
const { editWithExternalEditor, editorModule } = vi.hoisted(() => {
  let release: () => void = () => {};
  const loaded = new Promise<void>((resolve) => (release = resolve));
  return { editWithExternalEditor: vi.fn(async () => 'edited in editor'), editorModule: { loaded, release } };
});
// The editor module finishes loading only when a test releases it, so a test can close the dialog first.
vi.mock('./state/external-editor.js', async () => {
  await editorModule.loaded;
  return { editWithExternalEditor };
});

useTempAgentDir();
afterEach(() => vi.unstubAllEnvs());

const DOWN = '\x1b[B';
const ENTER = '\r';
const SPACE = ' ';
const COLLAPSE = '\x1d'; // ctrl+]
const UNDO = '\x1f'; // ctrl+-
const CTRL_G = '\x07';

const twoQuestions = (firstMulti: boolean) => ({
  questions: [
    {
      question: 'First?',
      header: 'First',
      ...(firstMulti ? { multiSelect: true } : {}),
      options: [
        { label: 'A', description: 'a' },
        { label: 'B', description: 'b' },
      ],
    },
    {
      question: 'Second?',
      header: 'Second',
      options: [
        { label: 'X', description: 'x' },
        { label: 'Y', description: 'y' },
      ],
    },
  ],
});

describe('fork fixes', () => {
  it('ignores typing while collapsed instead of editing the hidden draft', async () => {
    const q = askTool().call();
    await q.mounted;
    q.press(DOWN);
    q.press(DOWN); // "Type something."
    for (const c of 'abc') q.press(c);
    q.press(COLLAPSE);
    q.press('x');
    q.press(COLLAPSE);
    q.press(ENTER);
    expect((await q.result).details).toMatchObject({ answers: [{ kind: 'custom', answer: 'abc' }] });
  });

  it('leaves a blank multi-select unanswered when moving on, instead of answering "(no input)"', async () => {
    const q = askTool(twoQuestions(true)).call();
    await q.mounted;
    q.press(SPACE); // check A
    q.press(SPACE); // uncheck A
    for (let i = 0; i < 3; i++) q.press(DOWN); // "Next"
    q.press(ENTER);
    q.press(ENTER); // Second: X
    q.press(ENTER); // Submit
    const r = await q.result;
    expect(r.details).toMatchObject({ unanswered: [0], answers: [{ questionIndex: 1, answer: 'X' }] });
    expect(r.content[0]).toMatchObject({ text: expect.stringContaining('unanswered') });
  });

  it('keeps a note on a blank multi-select question when moving on', async () => {
    const q = askTool(twoQuestions(true)).call();
    await q.mounted;
    q.press('n');
    for (const c of 'none fit') q.press(c);
    q.press(ENTER); // save the note, nothing checked
    for (let i = 0; i < 3; i++) q.press(DOWN); // "Next"
    q.press(ENTER);
    q.press(ENTER); // Second: X
    q.press(ENTER); // Submit
    const r = await q.result;
    expect(r.details).toMatchObject({ answers: [{ questionIndex: 0, notes: 'none fit' }, { answer: 'X' }] });
    expect(r.content[0]).toMatchObject({ text: expect.stringContaining('none fit') });
  });

  it("keeps another tab's note out of the global note's undo history", async () => {
    const q = askTool(twoQuestions(false)).call();
    await q.mounted;
    q.press('n');
    for (const c of 'secret') q.press(c);
    q.press(ENTER); // save the note on First
    q.press(ENTER); // First: A
    q.press(ENTER); // Second: X, now on Submit
    q.press('n'); // blank global note
    q.press(UNDO); // must not bring back "secret"
    q.press(ENTER); // close the global note
    q.press(ENTER); // submit
    const r = await q.result;
    expect(r.details).toMatchObject({ answers: [{ answer: 'A', notes: 'secret' }, { answer: 'X' }] });
    expect(r.details).not.toHaveProperty('globalNote');
  });

  it('does not open the external editor for a dialog an answer already closed', async () => {
    vi.stubEnv('VISUAL', 'true');
    vi.stubEnv('EDITOR', 'true');
    const { call, bus } = askTool();
    const q = call();
    await q.mounted;
    q.press(DOWN);
    q.press(DOWN); // "Type something."
    q.press(CTRL_G); // starts loading the editor module, held by the barrier
    bus.emit(ASK_USER_ANSWER_EVENT, { toolCallId: 'tc', answers: [{ questionIndex: 0, optionIndexes: [1] }] });
    expect((await q.result).details).toMatchObject({ answers: [{ answer: 'Overlay' }] });
    editorModule.release();
    await import('./state/external-editor.js'); // the pending load has finished
    await new Promise((resolve) => setImmediate(resolve)); // and so has the code after it
    expect(editWithExternalEditor).not.toHaveBeenCalled();
  });
});
