import { access, open, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface TrustContext {
  cwd: string;
  isProjectTrusted?: () => boolean;
}
export interface Config {
  command: string;
  args: string[];
  initializationOptions: Record<string, unknown>;
  timeoutMs: number;
}
export function requireTrust(ctx: TrustContext): void {
  if (ctx.isProjectTrusted?.() !== true) throw new Error('LSP_UNTRUSTED: Trust this project in Pi before using lsp.');
}
export function inside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
export async function projectFile(root: string, input: string): Promise<string> {
  const lexical = resolve(root, input.replace(/^@/, ''));
  if (!inside(root, lexical)) throw new Error('LSP_PATH: File escapes project root.');
  const file = await realpath(lexical);
  if (!inside(root, file)) throw new Error('LSP_PATH: Symlink escapes project root.');
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file))
    throw new Error('LSP_LANGUAGE: Only TypeScript/JavaScript files are supported.');
  return file;
}
export async function documentText(root: string, file: string): Promise<string> {
  const canonical = await projectFile(root, file);
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
      throw new Error('LSP_FILE: Expected regular file of at most 2 MiB.');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export async function loadConfig(): Promise<Config> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(getAgentDir(), 'configs/lsp.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') value = {};
    else throw new Error(`LSP_CONFIG: ${String(error)}`);
  }
  if (
    !object(value) ||
    Object.keys(value).some((key) => !['command', 'args', 'initializationOptions', 'timeoutMs'].includes(key))
  )
    throw new Error('LSP_CONFIG: Expected object with command, args, initializationOptions, timeoutMs only.');
  const command = value.command ?? 'typescript-language-server';
  const args = value.args ?? ['--stdio'];
  const initializationOptions = value.initializationOptions ?? {};
  const timeoutMs = value.timeoutMs ?? 15000;
  if (
    typeof command !== 'string' ||
    !command ||
    command.includes('\0') ||
    (!isAbsolute(command) && /[/\\]/.test(command)) ||
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== 'string' || arg.includes('\0')) ||
    !object(initializationOptions) ||
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 120000
  )
    throw new Error('LSP_CONFIG: Invalid configuration values.');
  return { command, args: args as string[], initializationOptions, timeoutMs };
}
// PATH entries must be absolute and outside the project, including symlink targets.
// No shell, cwd fallback, node_modules probing, or package installation.
export async function trustedPath(root: string): Promise<string> {
  const entries: string[] = [];
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(entry)) continue;
    try {
      const dir = await realpath(entry);
      if (!inside(root, dir)) entries.push(dir);
    } catch {
      /* Ignore unavailable PATH entries. */
    }
  }
  return entries.join(delimiter);
}
export async function executable(config: Config, root: string): Promise<string> {
  if (isAbsolute(config.command)) return config.command; // Explicit global user authorization.
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(entry)) continue;
    try {
      const dir = await realpath(entry);
      if (inside(root, dir)) continue;
      const candidate = await realpath(join(dir, config.command));
      if (inside(root, candidate)) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Try the next trusted PATH entry. */
    }
  }
  throw new Error(
    'LSP_EXECUTABLE: Install typescript-language-server and typescript outside the project, or configure an absolute global command.',
  );
}
