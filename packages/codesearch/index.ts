import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { bounded, fetchFile, search } from './client.js';

const searchSchema = Type.Object({
  query: Type.String({ minLength: 1, description: 'Literal code pattern, not a natural-language question' }),
  regex: Type.Optional(Type.Boolean({ description: 'Interpret query as regex (default false)' })),
  caseSensitive: Type.Optional(Type.Boolean()),
  wholeWords: Type.Optional(Type.Boolean()),
  repo: Type.Optional(Type.String({ description: 'Public repository filter, e.g. facebook/react or vercel/' })),
  path: Type.Optional(Type.String({ description: 'File path filter' })),
  lang: Type.Optional(Type.Array(Type.String(), { description: 'Languages, e.g. TypeScript and TSX' })),
});
const fetchSchema = Type.Object({
  url: Type.Optional(
    Type.String({ description: 'HTTPS GitHub blob URL. Use explicit repo/path/ref for refs containing slashes.' }),
  ),
  repo: Type.Optional(Type.String({ description: 'owner/name, required with path if url omitted' })),
  path: Type.Optional(Type.String({ description: 'Repository-relative file path' })),
  ref: Type.Optional(Type.String({ description: 'Branch, tag or SHA. Defaults to repository default branch.' })),
  startLine: Type.Optional(Type.Integer({ minimum: 1, description: 'Inclusive 1-based first line (default 1)' })),
  endLine: Type.Optional(Type.Integer({ minimum: 1, description: 'Inclusive last line (default EOF)' })),
});
export type CodeSearchInput = Static<typeof searchSchema>;
export type CodeFetchInput = Static<typeof fetchSchema>;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'codesearch',
    label: 'Code Search',
    description:
      'Search public GitHub code via grep.app using literal patterns or regex, with repository, path and language filters. Queries leave this machine. Never submit secrets or private code without explicit user authorization. Output includes source URLs, bounded to 50 KiB / 2000 lines. Narrow filters if truncated. Independent of Exa, no API key required.',
    parameters: searchSchema,
    async execute(_id, params, signal) {
      return bounded(
        await search(params, signal),
        'Narrow query, repo, path or lang filters, then use codefetch for context.',
      );
    },
  });
  pi.registerTool({
    name: 'codefetch',
    label: 'Code Fetch',
    description:
      'Fetch a GitHub file via blob URL OR repo/path/ref, optionally an inclusive 1-based line range. Prefer authenticated gh, fall back to public GitHub API. Explicit ref supports slashes. Output bounded to 50 KiB / 2000 lines. Private file contents enter model context. Never submit fetched private code to codesearch without explicit user authorization.',
    parameters: fetchSchema,
    async execute(_id, params, signal) {
      const file = await fetchFile(pi, params, signal);
      const result = bounded(
        file.text || '(Empty file)',
        `Use codefetch with a narrower startLine/endLine range after line ${file.startLine}. A single oversized line cannot be returned.`,
      );
      return {
        ...result,
        details: {
          ...result.details,
          repo: file.repo,
          path: file.path,
          ref: file.ref,
          startLine: file.startLine,
          endLine: file.endLine,
          totalLines: file.totalLines,
        },
      };
    },
  });
}
