/**
 * Backtick Guard Extension
 *
 * Refuses a `bash` tool call whose command has a backtick command substitution
 * that bash would run. Models often put prose inside a double-quoted argument
 * (a PR body, a commit message), and a Markdown code span like `env` there runs
 * as a command whose output replaces the span. The mvdan/sh parser (via
 * sh-syntax) decides what bash would run: backticks in single quotes, quoted
 * heredocs, comments and escapes pass.
 *
 * Also adds a hint to the error when macOS's /bin/bash 3.2 fails on an
 * apostrophe inside `$(cat <<'EOF' … EOF)`, so the model switches to a file.
 *
 * Ported from fitchmultz/pi-fitch-kit's backtick-guard.
 */

import { type ExtensionAPI, isBashToolResult, isToolCallEventType } from '@earendil-works/pi-coding-agent';
import { createSourceIndex, parse, walk } from 'sh-syntax';

/** Longest substitution text quoted in a refusal; a span between two stray backticks can be long. */
const MAX_QUOTED_CHARS = 80;

const ADVICE =
  "Nothing ran. For a real substitution write $(...). To pass text that contains backticks, put the text in a file (a quoted heredoc, <<'EOF', keeps backticks literal) and pass the file, for example with --body-file.";

export const HEREDOC_HINT =
  "Hint: macOS /bin/bash 3.2 can't parse an apostrophe in a heredoc inside $(...). Write the text to a file first (cat > /tmp/body.md <<'EOF' ... EOF) and pass the file, for example with --body-file or git commit -F.";

/** The source text of each backtick command substitution that bash would run. */
async function backtickSubstitutions(command: string): Promise<string[]> {
  const file = await parse(command);
  const charIndex = createSourceIndex(command);
  const found: string[] = [];
  walk(file, (node) => {
    const runs = node.type === 'CmdSubst' && node.backquotes;
    if (runs) found.push(command.slice(charIndex(node.start), charIndex(node.end)));
    // The text of an outer substitution already contains the ones nested in it.
    return !runs;
  });
  return found;
}

/** Why the shell must not run this command, or undefined when it may. */
export async function refusal(command: string): Promise<string | undefined> {
  if (!command.includes('`')) return undefined;
  let substitutions: string[];
  try {
    substitutions = await backtickSubstitutions(command);
  } catch (error) {
    // Bash runs the lines before a syntax error, so an unread command is not a safe one.
    const message = error instanceof Error ? error.message : String(error);
    return `Blocked: unreadable command with a backtick. The bash parser stopped (${message}), so a backtick command substitution cannot be ruled out. ${ADVICE}`;
  }
  const [first, ...others] = substitutions;
  if (first === undefined) return undefined;
  // Slice by code point so the cut never splits a surrogate pair.
  const chars = Array.from(first);
  const quoted = chars.length > MAX_QUOTED_CHARS ? `${chars.slice(0, MAX_QUOTED_CHARS).join('')}…` : first;
  const more = others.length > 0 ? ` (and ${others.length} more)` : '';
  return `Blocked: backtick command substitution. The shell would run ${quoted}${more} as a command and paste its output into this one. ${ADVICE}`;
}

/** True for the bash 3.2 parse failure on a heredoc inside $(...). */
export function isHeredocParseFailure(command: string, output: string): boolean {
  return /\$\(\s*cat\s+<</.test(command) && output.includes('unexpected EOF while looking for matching');
}

export default function backtickGuard(pi: ExtensionAPI) {
  pi.on('tool_call', async (event) => {
    if (!isToolCallEventType('bash', event)) return;
    const reason = await refusal(event.input.command);
    return reason ? { block: true, reason } : undefined;
  });

  pi.on('tool_result', async (event) => {
    if (!isBashToolResult(event) || !event.isError) return;
    const output = event.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
    if (!isHeredocParseFailure(String(event.input.command ?? ''), output)) return;
    return { content: [...event.content, { type: 'text' as const, text: HEREDOC_HINT }] };
  });
}
