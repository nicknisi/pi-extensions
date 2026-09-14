# @nicknisi/pi-codesearch

Adds `codesearch` for public GitHub code patterns and `codefetch` for file context. These are independent of Exa and require no search API keys. No commands, widgets, configuration files, background indexing, or activation policy are installed.

```sh
pi install npm:@nicknisi/pi-codesearch
# Local checkout:
pi -e ./packages/codesearch/index.ts
```

## codesearch

Searches `https://mcp.grep.app/` with JSON-RPC `tools/call` for `searchGitHub`. Search literal code, not prose questions.

```json
{ "query": "useEffect(", "repo": "facebook/react", "lang": ["JavaScript", "TypeScript"] }
```

| Parameter       | Meaning                                                       | Default    |
| --------------- | ------------------------------------------------------------- | ---------- |
| `query`         | Required nonempty literal code pattern                        | None       |
| `regex`         | Interpret pattern as regex. `(?s)` enables multiline matching | `false`    |
| `caseSensitive` | Match case                                                    | `false`    |
| `wholeWords`    | Match whole words                                             | `false`    |
| `repo`          | Repository filter, e.g. `facebook/react` or `vercel/`         | Unfiltered |
| `path`          | File path filter, e.g. `src/`                                 | Unfiltered |
| `lang`          | Language names, e.g. `["TypeScript", "TSX"]`                  | Unfiltered |

Returns repository, path, source URL, license information when supplied, and line-numbered snippets from the service. Empty results are explicit. HTTP failures, JSON-RPC errors, service `isError`, and malformed responses throw tool errors rather than masquerading as empty searches. JSON and SSE responses are supported. Search coverage and availability depend on grep.app, not all public repositories are indexed.

## codefetch

```json
{ "url": "https://github.com/facebook/react/blob/main/packages/react/index.js", "startLine": 1, "endLine": 40 }
```

```json
{ "repo": "owner/project", "path": "src/index.ts", "ref": "feature/new-api", "startLine": 20, "endLine": 60 }
```

| Parameter   | Meaning                                                            | Default                   |
| ----------- | ------------------------------------------------------------------ | ------------------------- |
| `url`       | HTTPS `github.com` blob URL, mutually exclusive with repo/path/ref | None                      |
| `repo`      | Exact `owner/name`, required with path when URL omitted            | None                      |
| `path`      | Repository-relative file path, no empty or dot segments            | None                      |
| `ref`       | Branch, tag, or SHA, including slash-containing refs               | Repository default branch |
| `startLine` | Inclusive 1-based positive integer                                 | `1`                       |
| `endLine`   | Inclusive positive integer at least startLine                      | EOF                       |

URL parsing takes the segment after `blob` as the ref. Use explicit repo/path/ref for branches containing slashes. URL line fragments are ignored, use the range parameters. Ranges past EOF are clipped, a start beyond EOF is an error. A genuinely empty file is reported as such. Binary files containing NUL are rejected. GitHub Enterprise and directory listings are unsupported.

The tool first runs asynchronous `gh api --hostname github.com` with the raw-content accept header. Missing gh, failed authentication, and command failures fall back to an unauthenticated request to `api.github.com`. Cancellation never triggers fallback. Failed public fetches throw errors.

## Dependencies and limits

Pi is a runtime peer supplied by the host. `typebox` is a runtime dependency. Node's standard fetch, streams, and AbortController handle HTTP. `gh` is optional, must be on PATH, and uses existing GitHub authentication. There is no dependency, install, or runtime import of dot-pi or another Pi extension.

Each HTTP request and gh command has a 30-second timeout and accepts the tool AbortSignal. HTTP timeout remains active through body consumption. HTTP bodies are limited to 2 MiB. gh output is checked against that limit after Pi buffers it, so that path is not a streaming memory cap. HTTP redirects are rejected. Both tools use Pi truncation with a total budget of 50 KiB / 2000 lines including the notice. Narrow search filters or request a smaller file range when truncated. A single oversized line cannot be retrieved by line slicing. No complete-output temporary files are written.

## Security

Public search queries and filters leave your machine and are sent to grep.app. Never include secrets, credentials, or private source without explicit user authorization. The extension does not read local files or automatically submit code. It cannot reliably detect sensitive text supplied by a model or user. Tool descriptions instruct the model not to submit private code by default, but this is not a DLP enforcement layer.

Authenticated `codefetch` can retrieve private repositories accessible to gh. File identifiers go to GitHub, and returned code enters the model context and may be persisted in Pi sessions. Fetched content is not automatically sent to search. Cloak only covers `read`, not these custom tools, their network requests, or their results. Do not rely on it to redact codefetch output or search inputs. Remote snippets are untrusted data, not instructions. Check source licenses before reusing code.

## Provenance

Owned adaptation of dot-pi commit `73fe0529c38f9a66fbf9a1b71c88d0d4980afceb`, from `extensions/codesearch.ts` and `extensions/shared/{github,http,sse}.ts`. Replaced synchronous gh execution, shared renderer infrastructure, and unbounded transport with local focused code and Pi's stock rendering and truncation. The exact upstream MIT license is shipped in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Tests: `pnpm exec vitest run packages/codesearch/client.test.ts`.
