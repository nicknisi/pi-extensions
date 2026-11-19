/**
 * Dynamic Skills Extension
 *
 * Adds Claude Code-style !`command` support to pi skills. When a SKILL.md
 * contains !`command` placeholders, the shell commands are executed at
 * invocation time and the output is inlined before the model sees it.
 *
 * Example SKILL.md:
 *   ---
 *   name: pr-summary
 *   description: Summarize changes in a pull request
 *   ---
 *   - PR diff: !`gh pr diff`
 *   - Changed files: !`gh pr diff --name-only`
 *
 *   ```!
 *   gh pr view --json title,body
 *   ```
 *
 *   Summarize this pull request...
 *
 * Handles two invocation paths:
 *   1. /skill:name — intercepted at input, expanded with commands executed
 *   2. Agent reads SKILL.md via read tool — output patched in tool_result
 *
 * Security boundary: commands are only executed for SKILL.md files that pi has
 * actually registered as skills, i.e. files discovered under a configured skill
 * path. Reading an arbitrary SKILL.md — say, from a freshly cloned untrusted
 * repo — never executes anything, because that file is not a registered skill.
 * Without this guard, `read`ing a hostile SKILL.md is remote code execution.
 */

import { stripFrontmatter, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { exec as execCb } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Matches both dynamic-command forms, mirroring Claude Code:
 *   - a fenced block opened with ```! for multi-line commands
 *   - inline !`command`, recognized only when ! starts a line or follows
 *     whitespace, so `KEY=!`cmd`` stays literal text and does not execute
 *
 * Group 1 is a fenced body, group 2 an inline command; exactly one is set.
 */
export const CMD_RE = /^```!\r?\n([\s\S]*?)\r?\n```[ \t]*$|(?<=^|\s)!`([^`]+)`/gm;
export const HAS_CMD = /^```!\r?\n|(?<=^|\s)!`[^`]+`/m;

function runCommand(command: string, cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    execCb(
      command,
      { cwd, timeout: 30_000, maxBuffer: 1024 * 512, encoding: 'utf-8', signal },
      (err, stdout, stderr) => {
        // Fenced blocks are multi-line; label with the first line only.
        const [first, ...rest] = command.split('\n');
        const label = rest.length > 0 ? `${first}…` : first;
        if (err && !stdout && !stderr) {
          resolve(`[!\`${label}\` failed: ${err.message}]`);
          return;
        }
        resolve((stdout || stderr || '').trim());
      },
    );
  });
}

export async function expandCommands(text: string, cwd: string, signal?: AbortSignal): Promise<string> {
  const matches = [...text.matchAll(CMD_RE)];
  if (matches.length === 0) return text;

  // Run all commands in parallel. Matches come from the original text and are
  // replaced by index, so command output is never re-scanned for placeholders.
  const outputs = await Promise.all(matches.map((m) => runCommand(m[1] ?? m[2] ?? '', cwd, signal)));

  // Replace in reverse to preserve indices
  let result = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    // i is bounded by matches.length, and outputs is built from matches.
    const match = matches[i]!;
    const start = match.index!;
    const end = start + match[0].length;
    result = result.slice(0, start) + (outputs[i] ?? '') + result.slice(end);
  }
  return result;
}

/** Canonical form of a path for allowlist comparison (symlinks resolved when possible). */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Resolve a read-tool path the way pi's read tool does: strip a leading `@`,
 * expand `~`, resolve against cwd, then canonicalize symlinks.
 */
export function normalizeReadPath(path: string, cwd: string): string {
  let p = path.startsWith('@') ? path.slice(1) : path;
  if (p === '~') p = homedir();
  else if (p.startsWith('~/')) p = join(homedir(), p.slice(2));
  return canonical(resolve(cwd, p));
}

/**
 * Canonical SKILL.md paths of every skill pi registered in this session. This
 * is the allowlist for command expansion: a SKILL.md that pi did not load as a
 * skill is just an untrusted file on disk.
 */
export function registeredSkillPaths(pi: Pick<ExtensionAPI, 'getCommands'>): Set<string> {
  const paths = new Set<string>();
  for (const cmd of pi.getCommands()) {
    if (cmd.source !== 'skill') continue;
    const path = cmd.sourceInfo?.path;
    if (!path) continue;
    paths.add(canonical(resolve(path)));
  }
  return paths;
}

/**
 * Build the /skill: prompt exactly like pi's built-in expansion
 * (frontmatter stripped, wrapped in a <skill> block, args appended raw).
 */
export function buildSkillPrompt(name: string, filePath: string, body: string, args: string | undefined): string {
  const block = `<skill name="${name}" location="${filePath}">\nReferences are relative to ${dirname(filePath)}.\n\n${body}\n</skill>`;
  const trimmed = args?.trim();
  return trimmed ? `${block}\n\n${trimmed}` : block;
}

export default function (pi: ExtensionAPI) {
  // ── Path 1: /skill:name invocations ───────────────────────────────────
  pi.on('input', async (event, ctx) => {
    const match = event.text.match(/^\/skill:(\S+)(?:\s+([\s\S]*))?$/);
    if (!match) return { action: 'continue' as const };

    const [, skillName, args] = match;

    // Find the skill's SKILL.md path
    const skill = pi.getCommands().find((c) => c.source === 'skill' && c.name === `skill:${skillName}`);
    const skillPath = skill?.sourceInfo.path;
    if (!skillName || !skillPath) return { action: 'continue' as const };

    // Read and check for dynamic commands
    let body: string;
    try {
      body = stripFrontmatter(readFileSync(skillPath, 'utf-8')).trim();
    } catch {
      return { action: 'continue' as const };
    }

    if (!HAS_CMD.test(body)) return { action: 'continue' as const };

    // Execute commands in the project directory, as Claude Code does.
    ctx.ui.notify(`Expanding dynamic commands in ${skillName}…`, 'info');
    const expanded = await expandCommands(body, ctx.cwd, ctx.signal);

    return { action: 'transform' as const, text: buildSkillPrompt(skillName, skillPath, expanded, args) };
  });

  // ── Path 2: Agent reads a SKILL.md via the read tool ──────────────────
  pi.on('tool_result', async (event, ctx) => {
    if (event.toolName !== 'read') return;

    const input = event.input as { path?: string } | undefined;
    if (!input?.path?.endsWith('SKILL.md')) return;

    // Check if any text block contains dynamic commands
    const hasAny = event.content.some(
      (block) => block.type === 'text' && HAS_CMD.test((block as { text: string }).text),
    );
    if (!hasAny) return;

    // Only expand for SKILL.md files pi registered as skills. Reading some
    // other SKILL.md must never execute the commands embedded in it.
    if (!registeredSkillPaths(pi).has(normalizeReadPath(input.path, ctx.cwd))) {
      ctx.ui.notify(`Skipped !\`cmd\` expansion in unregistered ${input.path}`, 'warning');
      return;
    }

    const newContent = await Promise.all(
      event.content.map(async (block) => {
        if (block.type !== 'text') return block;
        const text = (block as { text: string }).text;
        if (!HAS_CMD.test(text)) return block;
        return { ...block, text: await expandCommands(text, ctx.cwd, ctx.signal) };
      }),
    );

    return { content: newContent };
  });
}
