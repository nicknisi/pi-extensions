/**
 * Spawn a real `pi -p` / `pi --mode json` subprocess for survival tests.
 *
 * Unlike the in-process AgentSession fixture, this drives an actual CLI process
 * to completion: it writes the scripted faux responses and low compaction
 * thresholds to disk, launches the installed `pi` bundle with the self-compact
 * and faux-provider extensions, and resolves only when the process exits. That
 * is what lets a test assert print/JSON single-shot modes do not dispose the
 * process before compaction and the continuation turn finish.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FauxResponseStep } from '@earendil-works/pi-ai';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');
const CLI_PATH = join(PACKAGE_ROOT, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
const HARNESS_PATH = join(HERE, 'cli-harness.ts');
const SELF_COMPACT_PATH = join(PACKAGE_ROOT, 'extensions', 'self-compact', 'self-compact.ts');

export interface CliRunOptions {
  mode: 'text' | 'json';
  responses: FauxResponseStep[];
  prompt: string;
  /** Low thresholds so a short scripted conversation has something to summarize. */
  keepRecentTokens?: number;
  reserveTokens?: number;
  contextWindow?: number;
  timeoutMs?: number;
  /** Raw self-compact threshold flags; defaults to window-independent percentages. */
  flags?: Record<string, string>;
}

export interface CliRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Working directory the CLI ran in; tool side effects (e.g. result.txt) land here. */
  dir: string;
  /** JSON events parsed from stdout (only meaningful in json mode). */
  jsonEvents(): Array<Record<string, unknown>>;
  dispose(): void;
}

/** Run one real CLI process to completion and capture its output. */
export async function runCli(options: CliRunOptions): Promise<CliRunResult> {
  const dir = mkdtempSync(join(tmpdir(), 'self-compact-cli-'));
  const agentDir = mkdtempSync(join(tmpdir(), 'self-compact-agent-'));
  const sessionDir = join(dir, '.sessions');
  const responsesPath = join(agentDir, 'faux-responses.json');

  writeFileSync(responsesPath, JSON.stringify(options.responses));
  writeFileSync(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      compaction: {
        enabled: true,
        keepRecentTokens: options.keepRecentTokens ?? 1,
        reserveTokens: options.reserveTokens ?? 1,
      },
      retry: { enabled: false },
    }),
  );

  const args = [
    CLI_PATH,
    '-p',
    ...(options.mode === 'json' ? ['--mode', 'json'] : []),
    '--provider',
    'faux',
    '--model',
    'faux-1',
    '--session-dir',
    sessionDir,
    '--offline',
    '--no-context-files',
    '-ne',
    '-e',
    HARNESS_PATH,
    '-e',
    SELF_COMPACT_PATH,
    // Window-independent thresholds so the fail-closed gate never blocks the
    // scripted survival flow regardless of the faux context window.
    '--compact-soft-at',
    options.flags?.['compact-soft-at'] ?? '50%',
    '--compact-at',
    options.flags?.['compact-at'] ?? '70%',
    '--compact-buffer',
    options.flags?.['compact-buffer'] ?? '10%',
    options.prompt,
  ];

  const child = spawn(process.execPath, args, {
    cwd: dir,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      SELF_COMPACT_FAUX_RESPONSES: responsesPath,
      SELF_COMPACT_FAUX_CONTEXT_WINDOW: String(options.contextWindow ?? 200000),
      PI_OFFLINE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const timeoutMs = options.timeoutMs ?? 45000;
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI run timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  return {
    exitCode,
    stdout,
    stderr,
    dir,
    jsonEvents: () =>
      stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>];
          } catch {
            return [];
          }
        }),
    dispose: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    },
  };
}
