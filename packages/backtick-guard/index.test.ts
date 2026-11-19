import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import backtickGuard, { HEREDOC_HINT, isHeredocParseFailure, refusal } from './index.js';

describe('refusal', () => {
  it.each([
    ['a code span in a double-quoted argument', 'gh pr create --body "uses `env` to read it"', '`env`'],
    ['an unquoted backtick word', 'echo `whoami`', '`whoami`'],
    ['an unquoted-delimiter heredoc', 'cat <<EOF\nrun `date`\nEOF', '`date`'],
  ])('refuses %s', async (_name, command, quoted) => {
    const reason = await refusal(command);
    expect(reason).toContain('Blocked: backtick command substitution');
    expect(reason).toContain(quoted);
    expect(reason).toContain('--body-file');
  });

  it.each([
    ['single quotes', "echo 'uses `env` here'"],
    ['a quoted heredoc', "cat <<'EOF'\nuses `env` here\nEOF"],
    ['a quoted heredoc inside $(...)', 'gh pr create --body "$(cat <<\'EOF\'\nuses `env`\nEOF\n)"'],
    ['a comment', 'echo hi # see `env`'],
    ['an escaped backtick', 'echo "a \\`literal\\` tick"'],
    ['no backtick at all', 'echo "$(date)"'],
  ])('allows backticks in %s', async (_name, command) => {
    expect(await refusal(command)).toBeUndefined();
  });

  it('refuses an unreadable command that has a backtick, since bash runs the lines before the error', async () => {
    expect(await refusal("touch before\necho 'it`s")).toContain('Blocked: unreadable command with a backtick');
  });

  it('counts the other substitutions and quotes only the outermost', async () => {
    const reason = await refusal('echo "`a \\`b\\``" `c`');
    expect(reason).toContain('(and 1 more)');
  });

  it('shortens a long substitution without splitting an emoji', async () => {
    const reason = await refusal(`echo "\`${'x'.repeat(78)}😀${'y'.repeat(100)}\`"`);
    expect(reason).toContain(`\`${'x'.repeat(78)}😀…`);
  });
});

/** The guard's handlers, registered against a stub API. */
function handlers() {
  const on = new Map<string, (event: unknown) => Promise<unknown>>();
  backtickGuard({ on: (name: string, h: never) => on.set(name, h) } as unknown as ExtensionAPI);
  return { toolCall: on.get('tool_call')!, toolResult: on.get('tool_result')! };
}

describe('extension', () => {
  it('blocks a bash call and ignores other tools', async () => {
    const { toolCall } = handlers();
    const bash = (command: string) => ({ type: 'tool_call', toolName: 'bash', toolCallId: '1', input: { command } });
    expect(await toolCall(bash('echo "`env`"'))).toMatchObject({ block: true });
    expect(await toolCall(bash('echo "$(env)"'))).toBeUndefined();
    expect(
      await toolCall({ type: 'tool_call', toolName: 'write', toolCallId: '2', input: { path: 'a', content: '`env`' } }),
    ).toBeUndefined();
  });

  it('adds the heredoc hint only to the bash 3.2 parse failure', async () => {
    const { toolResult } = handlers();
    const command = "gh pr create --body \"$(cat <<'EOF'\nit's here\nEOF\n)\"";
    const failed = (text: string, isError = true) => ({
      toolName: 'bash',
      toolCallId: '1',
      input: { command },
      content: [{ type: 'text', text }],
      isError,
    });
    const error = "line 2: unexpected EOF while looking for matching `''";
    expect(await toolResult(failed(error))).toEqual({
      content: [
        { type: 'text', text: error },
        { type: 'text', text: HEREDOC_HINT },
      ],
    });
    expect(await toolResult(failed('some other failure'))).toBeUndefined();
    expect(await toolResult(failed(error, false))).toBeUndefined();
  });
});

describe('isHeredocParseFailure', () => {
  it('matches the real /bin/bash 3.2 error output', () => {
    const command = "echo \"$(cat <<'EOF'\nit's broken\nEOF\n)\"";
    let output = '';
    try {
      output = execFileSync('/bin/bash', ['-c', command], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      output = String((error as { stderr?: string }).stderr);
    }
    // Only macOS ships bash 3.2 as /bin/bash; elsewhere the command just works.
    if (!output.includes("it's broken")) expect(isHeredocParseFailure(command, output)).toBe(true);
    expect(isHeredocParseFailure('echo hi', output)).toBe(false);
  });

  it('matches the no-space cat<< form', () => {
    const output = 'bash: -c: line 1: unexpected EOF while looking for matching `"\'';
    expect(isHeredocParseFailure("echo \"$(cat<<'EOF'\nit's broken\nEOF\n)\"", output)).toBe(true);
    expect(isHeredocParseFailure('echo "$(catalog <<\'EOF\'\nx\nEOF\n)"', output)).toBe(false);
  });
});
