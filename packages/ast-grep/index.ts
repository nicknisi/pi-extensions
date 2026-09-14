// Adapted from dannote/dot-pi extensions/ast-grep.ts. See THIRD_PARTY_NOTICES.md.
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type ExtensionAPI, truncateHead, truncateLine, withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';

const common = {
  pattern: Type.String({
    minLength: 1,
    description: 'AST pattern. $NAME captures one node, $$$NAME captures multiple nodes.',
  }),
  lang: Type.Optional(
    Type.String({
      minLength: 1,
      description: 'Language, e.g. typescript, tsx, python. Default: infer from file extensions.',
    }),
  ),
  timeout: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 300000,
      description: 'CLI timeout in milliseconds (default: 30000, maximum: 300000).',
    }),
  ),
};
const searchSchema = Type.Object({
  ...common,
  path: Type.Optional(
    Type.String({ minLength: 1, description: 'File or directory to search, relative to cwd (default: .).' }),
  ),
});
const rewriteSchema = Type.Object({
  ...common,
  path: Type.String({
    minLength: 1,
    description: 'Explicit file to rewrite, relative to cwd. Directories are not supported.',
  }),
  replacement: Type.String({
    description: 'Replacement pattern using captured metavariables. Empty string deletes matches.',
  }),
  dryRun: Type.Optional(
    Type.Boolean({ description: 'Preview without writing (default: true). Only explicit false applies changes.' }),
  ),
});
export type AstSearchInput = Static<typeof searchSchema>;
export type AstRewriteInput = Static<typeof rewriteSchema>;

// Retain the beginning of native output, including diff file headings and line numbers.
function bounded(output: string) {
  const lines = output.split('\n');
  let clipped = false;
  const shortened = lines
    .map((line) => {
      const result = truncateLine(line, 2000);
      clipped ||= result.wasTruncated;
      return result.text;
    })
    .join('\n');
  const result = truncateHead(shortened, { maxLines: 500, maxBytes: 30000 });
  const truncated = clipped || result.truncated;
  return {
    text:
      result.content +
      (truncated
        ? '\n[Output truncated to 500 lines / 30000 bytes, with 2000-character lines. Narrow the path or pattern to see omitted results. Do not repeat an applied rewrite to retrieve output.]'
        : ''),
    truncated,
  };
}

async function run(
  pi: Pick<ExtensionAPI, 'exec'>,
  params: AstSearchInput | AstRewriteInput,
  cwd: string,
  signal: AbortSignal | undefined,
) {
  const rewrite = 'replacement' in params;
  const apply = rewrite && params.dryRun === false;
  if (rewrite && (typeof params.path !== 'string' || !params.path.trim())) {
    throw new Error('ast_rewrite requires an explicit file path.');
  }
  const path = resolve(cwd, (params.path ?? '.').replace(/^@/, ''));
  const execute = async () => {
    signal?.throwIfAborted();
    if (rewrite && !(await stat(path)).isFile()) {
      throw new Error('ast_rewrite requires a file, not a directory. Rewrite files individually.');
    }
    const args = ['run', `--pattern=${params.pattern}`, '--color=never', '--heading=never'];
    if (params.lang) args.push(`--lang=${params.lang}`);
    if (rewrite) args.push(`--rewrite=${params.replacement}`);
    if (apply) args.push('--update-all');
    args.push('--', path);
    let result;
    try {
      const options = { cwd, ...(signal ? { signal } : {}), timeout: params.timeout ?? 30000 };
      // Pi's exec can report spawn ENOENT as an empty exit 1, identical to no matches.
      const version = await pi.exec('ast-grep', ['--version'], options);
      if (signal?.aborted || version.killed) throw new Error('ast-grep cancelled or timed out during version check.');
      if (version.code !== 0 || !/^ast-grep \d/m.test(version.stdout)) {
        throw new Error(
          `ast-grep executable unavailable or incompatible. Install the ast-grep CLI and expose ast-grep on PATH. ${bounded(version.stderr).text}`,
        );
      }
      signal?.throwIfAborted();
      result = await pi.exec('ast-grep', args, options);
    } catch (error) {
      signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || message.includes('ENOENT')) {
        throw new Error('ast-grep executable not found. Install the ast-grep CLI and expose ast-grep on PATH.');
      }
      throw new Error(`ast-grep could not execute: ${bounded(message).text}`);
    }
    const caution = apply ? ' Files may already be partially modified. Inspect the diff before retrying.' : '';
    if (signal?.aborted || result.killed) {
      throw new Error(`ast-grep cancelled or timed out.${caution}`);
    }
    // Exit 1 means no matches only when both streams are empty. Never hide diagnostics.
    const noMatches = !result.stdout.trim() && !result.stderr.trim() && (result.code === 0 || result.code === 1);
    if (!noMatches && result.code !== 0) {
      throw new Error(
        `ast-grep failed (exit ${result.code}).${caution}\n${bounded(result.stderr || result.stdout).text}`,
      );
    }
    const output = bounded([result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join('\n'));
    const status = rewrite ? (apply ? 'Applied rewrite.' : 'Preview only. No files changed.') : 'Search results.';
    return {
      content: [{ type: 'text' as const, text: `${status}\n${noMatches ? 'No matches found.' : output.text}` }],
      details: { path, dryRun: !apply, noMatches, truncated: output.truncated },
    };
  };
  return apply ? withFileMutationQueue(path, execute) : execute();
}

export default function (pi: ExtensionAPI) {
  const limits =
    ' Output is bounded to 500 lines / 30000 bytes with 2000-character lines. Narrow the path or pattern if truncated.';
  pi.registerTool({
    name: 'ast_search',
    label: 'AST Search',
    description:
      'Search code by AST syntax pattern, not types. Example: console.log($MSG). Uses the installed ast-grep CLI.' +
      limits,
    parameters: searchSchema,
    execute: (_id, params, signal, _update, ctx) => run(pi, params, ctx.cwd, signal),
  });
  pi.registerTool({
    name: 'ast_rewrite',
    label: 'AST Rewrite',
    description:
      'Rewrite AST syntax matches in an explicit file. Not type-aware. Native CLI preview is the default. Set dryRun:false explicitly to apply every match in that file. Preview first and inspect the diff afterward.' +
      limits,
    parameters: rewriteSchema,
    execute: (_id, params, signal, _update, ctx) => run(pi, params, ctx.cwd, signal),
  });
}
