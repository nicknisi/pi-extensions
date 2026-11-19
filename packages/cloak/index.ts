import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

type CloakPatternSpec =
  | string
  | {
      pattern: string;
      replace?: string;
      flags?: string;
    };

interface CloakRuleConfig {
  filePattern: string | string[];
  cloakPattern: CloakPatternSpec | CloakPatternSpec[];
  replace?: string;
  /** Apply to every read/bash/grep result, not only output from files matching `filePattern`. */
  global?: boolean;
}

interface CloakConfig {
  enabled?: boolean;
  cloakCharacter?: string;
  cloakLength?: number | null;
  tryAllPatterns?: boolean;
  patterns?: CloakRuleConfig[];
}

interface CompiledCloakPattern {
  source: string;
  regex: RegExp;
  replace?: string | undefined;
}

interface CompiledCloakRule {
  global: boolean;
  filePatterns: string[];
  fileRegexes: RegExp[];
  patterns: CompiledCloakPattern[];
}

/** Paths that select rules, with the cwd they are relative to. */
export interface PathSource {
  paths: string[];
  cwd: string;
}

interface RuntimeState {
  configPath: string;
  config: CloakConfig;
  rules: CompiledCloakRule[];
  error?: string;
  /** Config file exists but could not be loaded: withhold tool output instead of passing it through. */
  failClosed?: boolean;
}

function missingConfigMessage(configPath: string): string {
  return `pi-cloak config not found at ${configPath}`;
}

const CLOAKED_TOOLS = new Set(['read', 'bash', 'powershell', 'grep']);
const SHELL_TOOLS = new Set(['bash', 'powershell']);

const DEFAULT_CONFIG_PATH = join(getAgentDir(), 'cloak.json');
const DEFAULT_CONFIG: CloakConfig = {
  enabled: true,
  cloakCharacter: '*',
  cloakLength: null,
  tryAllPatterns: true,
  patterns: [],
};

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeSlashes(value: string): string {
  return value.split('\\').join('/');
}

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function normalizePath(value: string): string {
  return normalizeSlashes(expandHome(value.trim()));
}

function stripLeadingAt(value: string): string {
  return value.startsWith('@') ? value.slice(1) : value;
}

function stripLeadingDotSlash(value: string): string {
  return value.replace(/^(?:\.\/)+/, '');
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(glob: string): RegExp {
  const normalized = stripLeadingDotSlash(normalizePath(glob));
  let pattern = '^';

  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index]!;
    const next = normalized[index + 1];
    const afterNext = normalized[index + 2];

    if (char === '*' && next === '*') {
      if (afterNext === '/') {
        pattern += '(?:.*/)?';
        index += 2;
      } else {
        pattern += '.*';
        index += 1;
      }
      continue;
    }

    if (char === '*') {
      pattern += '[^/]*';
      continue;
    }

    if (char === '?') {
      pattern += '[^/]';
      continue;
    }

    pattern += escapeRegex(char);
  }

  pattern += '$';
  return new RegExp(pattern);
}

// Patterns run over the whole text; `m` keeps `^`/`$` anchored per line as when patterns ran line-by-line.
function ensureGlobalFlags(flags?: string): string {
  const unique = new Set((flags ?? '').split('').filter(Boolean));
  unique.add('g');
  unique.add('m');
  return Array.from(unique).join('');
}

function compilePattern(spec: CloakPatternSpec, ruleReplace?: string): CompiledCloakPattern {
  if (typeof spec === 'string') {
    return {
      source: spec,
      regex: new RegExp(spec, ensureGlobalFlags()),
      replace: ruleReplace,
    };
  }

  return {
    source: spec.pattern,
    regex: new RegExp(spec.pattern, ensureGlobalFlags(spec.flags)),
    replace: spec.replace ?? ruleReplace,
  };
}

function compileRule(rule: CloakRuleConfig): CompiledCloakRule {
  const filePatterns = toArray(rule.filePattern);
  const cloakPatterns = toArray(rule.cloakPattern);

  return {
    global: rule.global === true,
    filePatterns,
    fileRegexes: filePatterns.map(globToRegExp),
    patterns: cloakPatterns.map((pattern) => compilePattern(pattern, rule.replace)),
  };
}

export function loadState(configPath: string = DEFAULT_CONFIG_PATH): RuntimeState {
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as CloakConfig;
    const config: CloakConfig = {
      ...DEFAULT_CONFIG,
      ...parsed,
      patterns: parsed.patterns ?? [],
    };

    const rules: CompiledCloakRule[] = [];
    const ruleErrors: string[] = [];
    (config.patterns ?? []).forEach((rule, index) => {
      try {
        rules.push(compileRule(rule));
      } catch (error) {
        ruleErrors.push(
          `pi-cloak skipped rule #${index + 1} in ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });

    return {
      configPath,
      config,
      rules,
      ...(ruleErrors.length > 0 ? { error: ruleErrors.join('\n') } : {}),
    };
  } catch (error) {
    const isMissingFile = error instanceof Error && 'code' in error && error.code === 'ENOENT';

    return {
      configPath,
      config: DEFAULT_CONFIG,
      rules: [],
      error: isMissingFile
        ? missingConfigMessage(configPath)
        : `pi-cloak failed to load ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      ...(isMissingFile ? {} : { failClosed: true }),
    };
  }
}

function getPathCandidates(rawPath: string, cwd: string): string[] {
  const cleanPath = normalizePath(stripLeadingAt(rawPath));
  const absolutePath = normalizePath(resolve(cwd, expandHome(stripLeadingAt(rawPath))));
  // cwd-relative form, so `config/secrets.json` also matches `/abs/cwd/config/secrets.json` and `./config/secrets.json`.
  const relativePath = normalizeSlashes(relative(cwd, absolutePath));
  const candidates = [
    cleanPath,
    stripLeadingDotSlash(cleanPath),
    absolutePath,
    basename(cleanPath),
    basename(absolutePath),
  ];
  if (relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath)) candidates.push(relativePath);

  return Array.from(new Set(candidates));
}

function ruleMatchesPath(rule: CompiledCloakRule, rawPath: string, cwd: string): boolean {
  const candidates = getPathCandidates(rawPath, cwd);
  return candidates.some((candidate) => rule.fileRegexes.some((regex) => regex.test(candidate)));
}

function repeatToLength(seed: string, length: number): string {
  if (length <= 0) return '';
  if (!seed) return '';

  const pieces: string[] = [];
  let totalLength = 0;
  while (totalLength < length) {
    pieces.push(seed);
    totalLength += seed.length;
  }

  return pieces.join('').slice(0, length);
}

function applyReplacementTemplate(template: string, match: string, captures: string[]): string {
  let result = '';

  for (let index = 0; index < template.length; index++) {
    const char = template[index]!;
    if (char !== '$') {
      result += char;
      continue;
    }

    const next = template[index + 1];
    if (!next) {
      result += '$';
      continue;
    }

    if (next === '$') {
      result += '$';
      index += 1;
      continue;
    }

    if (next === '&') {
      result += match;
      index += 1;
      continue;
    }

    if (/\d/.test(next)) {
      let end = index + 1;
      while (end + 1 < template.length && /\d/.test(template[end + 1]!) && end - index < 2) {
        end += 1;
      }

      const groupIndex = Number(template.slice(index + 1, end + 1)) - 1;
      result += captures[groupIndex] ?? '';
      index = end;
      continue;
    }

    result += `$${next}`;
    index += 1;
  }

  return result;
}

function buildMaskedReplacement(
  match: string,
  captures: string[],
  replace: string | undefined,
  cloakCharacter: string,
  cloakLength: number | null | undefined,
): string {
  const visible = replace ? applyReplacementTemplate(replace, match, captures) : match.slice(0, 1);
  const targetLength = cloakLength ?? Math.max(match.length, visible.length);
  const truncatedVisible = visible.slice(0, targetLength);
  const maskedLength = Math.max(0, targetLength - truncatedVisible.length);
  return truncatedVisible + repeatToLength(cloakCharacter, maskedLength);
}

function lineBounds(text: string, start: number, end: number): [number, number] {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = text.indexOf('\n', end);
  return [lineStart, lineEnd === -1 ? text.length : lineEnd];
}

function applyPatterns(
  text: string,
  patterns: CompiledCloakPattern[],
  config: CloakConfig,
): { text: string; changed: boolean } {
  let updated = text;
  let changed = false;
  // Per-character "changed by an earlier pattern" marks, so tryAllPatterns=false still stops per line.
  let marks: boolean[] | undefined;

  const trackMarks = !config.tryAllPatterns;

  for (const pattern of patterns) {
    let next = '';
    const nextMarks: boolean[] = [];
    let last = 0;
    let matchedThisPattern = false;

    for (const found of updated.matchAll(pattern.regex)) {
      const match = found[0];
      const index = found.index;
      if (marks) {
        const [lineStart, lineEnd] = lineBounds(updated, index, index + match.length);
        if (marks.slice(lineStart, lineEnd).some(Boolean)) continue;
      }

      const captures = found.slice(1).map((value) => String(value ?? ''));
      const replacement = buildMaskedReplacement(
        match,
        captures,
        pattern.replace,
        config.cloakCharacter ?? '*',
        config.cloakLength,
      );
      if (replacement === match) continue;

      matchedThisPattern = true;
      next += updated.slice(last, index) + replacement;
      if (trackMarks) {
        for (let i = last; i < index; i++) nextMarks.push(marks?.[i] ?? false);
        for (let i = 0; i < replacement.length; i++) nextMarks.push(true);
      }
      last = index + match.length;
    }

    if (matchedThisPattern) {
      if (trackMarks) {
        for (let i = last; i < updated.length; i++) nextMarks.push(marks?.[i] ?? false);
        marks = nextMarks;
      }
      next += updated.slice(last);
      updated = next;
      changed = true;
    }
  }

  return { text: updated, changed };
}

/**
 * Cloak `rawText` with the rules that are `global` or whose file glob matches one of `rawPaths`:
 * the read path, the files a bash command names, or grep's path and glob. `extraSources` adds paths resolved
 * against their own cwd (e.g. the command that produced a saved shell-output file).
 */
export function cloakText(
  rawText: string,
  rawPaths: string | string[],
  cwd: string,
  state: RuntimeState,
  extraSources: PathSource[] = [],
): string {
  if (!state.config.enabled) return rawText;

  const sources: PathSource[] = [{ paths: typeof rawPaths === 'string' ? [rawPaths] : rawPaths, cwd }, ...extraSources];
  const matchingRules = state.rules.filter(
    (rule) =>
      rule.global || sources.some((source) => source.paths.some((path) => ruleMatchesPath(rule, path, source.cwd))),
  );
  if (matchingRules.length === 0) return rawText;

  let updated = rawText;
  let changed = false;

  for (const rule of matchingRules) {
    const result = applyPatterns(updated, rule.patterns, state.config);
    if (result.changed) {
      updated = result.text;
      changed = true;
    }
  }

  return changed ? updated : rawText;
}

// pi's grep tool prints `<path>:<n>: <text>` for matches and `<path>-<n>- <text>` for context lines.
const GREP_LINE = /^(.*?)(?::\d+: |-\d+- )/;

/**
 * Cloak grep tool output: each line's file path (relative to the searched directory) selects rules. Consecutive
 * lines from the same file are cloaked together with their `<path>:<n>: ` prefixes stripped, so `^` anchors at the
 * file line's start and multi-line patterns (PEM blocks) see the whole block. `inputPaths` (grep's `path` and `glob`)
 * select rules for every line.
 */
export function cloakGrepText(
  rawText: string,
  inputPaths: string[],
  searchPath: string | undefined,
  cwd: string,
  state: RuntimeState,
  extraSources: PathSource[] = [],
): string {
  if (!state.config.enabled) return rawText;

  const lines = rawText.split('\n');
  const out: string[] = [];
  for (let index = 0; index < lines.length;) {
    const linePath = GREP_LINE.exec(lines[index]!)?.[1];
    if (!linePath) {
      out.push(cloakText(lines[index]!, inputPaths, cwd, state, extraSources));
      index++;
      continue;
    }

    const prefixes: string[] = [];
    const bodies: string[] = [];
    for (; index < lines.length; index++) {
      const prefix = GREP_LINE.exec(lines[index]!);
      if (!prefix || prefix[1] !== linePath) break;
      prefixes.push(prefix[0]);
      bodies.push(lines[index]!.slice(prefix[0].length));
    }

    const paths = [...inputPaths, linePath, join(searchPath ?? '.', linePath)];
    const masked = cloakText(bodies.join('\n'), paths, cwd, state, extraSources).split('\n');
    if (masked.length === prefixes.length) {
      out.push(...masked.map((body, i) => prefixes[i] + body));
    } else {
      // A multi-line match collapsed lines: line numbers no longer line up, so keep only the first prefix.
      out.push(prefixes[0] + masked.join('\n'));
    }
  }

  const text = out.join('\n');
  return text === rawText ? rawText : text;
}

export default function (pi: ExtensionAPI) {
  let state = loadState();
  // Truncated shell output is saved in full to a temp file; remember which paths (and the cwd they are relative to)
  // selected rules for it, so a later read of that file is cloaked the same way. Keyed by absolute path.
  const fullOutputSources = new Map<string, PathSource[]>();
  const fullOutputSourcesFor = (paths: string[], cwd: string): PathSource[] =>
    paths.flatMap((path) => fullOutputSources.get(resolve(cwd, expandHome(stripLeadingAt(path)))) ?? []);

  const reloadConfig = () => {
    state = loadState();
  };

  pi.on('session_start', async (_event, ctx) => {
    reloadConfig();
    fullOutputSources.clear();

    if (state.error) {
      if (ctx.hasUI) ctx.ui.notify(state.error, 'warning');
      else if (state.error !== missingConfigMessage(state.configPath)) console.error(state.error);
    }
  });

  pi.registerCommand('cloak-status', {
    description: 'Show pi-cloak config status',
    handler: async (_args, ctx) => {
      reloadConfig();

      const summary = state.error
        ? `${state.error}\npatterns: ${state.rules.length}`
        : `pi-cloak enabled=${state.config.enabled !== false} patterns=${state.rules.length} config=${state.configPath}`;

      ctx.ui.notify(summary, state.error ? 'warning' : 'info');
    },
  });

  pi.on('tool_result', async (event, ctx) => {
    if (!CLOAKED_TOOLS.has(event.toolName)) return undefined;

    if (state.failClosed) {
      const text = `[pi-cloak: ${event.toolName} output withheld because the cloak config could not be loaded. ${state.error ?? ''}]`;
      return { content: [{ type: 'text' as const, text }] };
    }

    if (!state.config.enabled) return undefined;

    const input = (event.input ?? {}) as Record<string, unknown>;
    const strings = (...values: unknown[]) => values.filter((v): v is string => typeof v === 'string' && v !== '');
    let rawPaths: string[];
    if (event.toolName === 'read') {
      rawPaths = strings(input.path);
      if (rawPaths.length === 0) return undefined;
    } else if (event.toolName === 'grep') {
      rawPaths = strings(input.path, input.glob);
    } else {
      // shortcut: shell output is matched to rules by the file names its command mentions (`cat .env`); a secret
      // printed without naming its file (`env`, `rg KEY`) needs a `global` rule.
      rawPaths = typeof input.command === 'string' ? input.command.split(/[\s;|&<>()'"`=]+/).filter(Boolean) : [];
    }
    const extraSources = fullOutputSourcesFor(rawPaths, ctx.cwd);

    if (SHELL_TOOLS.has(event.toolName)) {
      const fullOutputPath = (event.details as { fullOutputPath?: unknown } | undefined)?.fullOutputPath;
      if (typeof fullOutputPath === 'string' && (rawPaths.length > 0 || extraSources.length > 0)) {
        fullOutputSources.set(resolve(ctx.cwd, fullOutputPath), [{ paths: rawPaths, cwd: ctx.cwd }, ...extraSources]);
      }
    }
    const searchPath = event.toolName === 'grep' && typeof input.path === 'string' ? input.path : undefined;

    let changed = false;
    const content = event.content.map((part) => {
      if (part.type !== 'text' || typeof part.text !== 'string') {
        return part;
      }

      const cloakedText =
        event.toolName === 'grep'
          ? cloakGrepText(part.text, rawPaths, searchPath, ctx.cwd, state, extraSources)
          : cloakText(part.text, rawPaths, ctx.cwd, state, extraSources);
      if (cloakedText === part.text) {
        return part;
      }

      changed = true;
      return {
        ...part,
        text: cloakedText,
      };
    });

    if (!changed) return undefined;
    return { content };
  });
}
