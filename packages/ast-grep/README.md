# @nicknisi/pi-ast-grep

Adds `ast_search` and `ast_rewrite` using your existing [ast-grep CLI](https://ast-grep.github.io/). This package owns its implementation. It does not install, import, or depend on dot-pi or another Pi extension. Pi stock tool rendering is used, with no rendering or diff dependencies.

## Requirements and installation

Install the ast-grep CLI separately and ensure `ast-grep --version` works on Pi's `PATH`. The wrapper deliberately uses `ast-grep`, not `sg`, which can name an unrelated system utility. Tested with ast-grep 0.45.3. Pi is a peer dependency provided by the host. `typebox` is a runtime dependency. The host must export `withFileMutationQueue` (available in Pi 0.84.0).

```sh
pi install npm:@nicknisi/pi-ast-grep
```

For a local checkout, use `pi install ./packages/ast-grep`. No configuration files, environment settings, commands, or widgets are added. The Pi manifest loads `index.ts`. Node consumers use compiled `dist` exports.

## Tools and parameters

### ast_search

Search a file or directory for structural syntax matches.

| Parameter | Required | Default                       | Meaning                                                                                |
| --------- | -------- | ----------------------------- | -------------------------------------------------------------------------------------- |
| `pattern` | Yes      | None                          | Nonempty AST pattern. `$NAME` captures one node and `$$$NAME` captures multiple nodes. |
| `lang`    | No       | Inferred from file extensions | ast-grep language name, such as `typescript`, `tsx`, `python`, `go`, or `rust`.        |
| `path`    | No       | `.`                           | File or directory, relative to Pi's working directory or absolute.                     |
| `timeout` | No       | `30000`                       | Milliseconds per CLI process, integer from 1 through 300000.                           |

```json
{ "pattern": "console.log($MSG)", "lang": "typescript", "path": "src" }
```

### ast_rewrite

Preview replacements in one explicitly named file. **Only `dryRun: false` writes changes.** Omitting `dryRun` is safe preview mode. Native ast-grep preview supplies the diff, without temporary source copies or custom diff generation.

| Parameter     | Required | Default                      | Meaning                                                                    |
| ------------- | -------- | ---------------------------- | -------------------------------------------------------------------------- |
| `pattern`     | Yes      | None                         | Nonempty AST pattern, with the same captures as search.                    |
| `replacement` | Yes      | None                         | Replacement using captured metavariables. An empty string deletes matches. |
| `path`        | Yes      | None                         | Explicit existing file. Empty paths and directories are rejected.          |
| `lang`        | No       | Inferred from file extension | ast-grep language name.                                                    |
| `dryRun`      | No       | `true`                       | Preview only unless explicitly `false`.                                    |
| `timeout`     | No       | `30000`                      | Milliseconds per CLI process, integer from 1 through 300000.               |

Preview:

```json
{ "pattern": "console.log($MSG)", "replacement": "logger.debug($MSG)", "path": "src/main.ts" }
```

Apply after reviewing the preview:

```json
{ "pattern": "console.log($MSG)", "replacement": "logger.debug($MSG)", "path": "src/main.ts", "dryRun": false }
```

## Behavior and limits

- **Syntax, not types:** AST matching is not type-aware. It does not resolve symbols, overloads, imports, or runtime behavior. Validate rewrites with your project's checks.
- **File scope:** Search accepts directories, but rewrite intentionally accepts one file per call. This allows applied rewrites to join Pi's per-file mutation queue, including canonicalized symlink aliases, rather than racing built-in edit/write calls. External processes are not coordinated. All matches in that file are applied, without an additional confirmation dialog or undo mechanism. Keep a recoverable working tree and inspect the diff.
- **Paths and discovery:** Paths resolve against `ctx.cwd`, with a leading `@` removed for Pi compatibility. Tilde expansion, shell globs, pipes, and shell interpolation are not performed. CLI arguments are passed directly through `pi.exec`, with `--` before the absolute path. ast-grep's normal language discovery, ignore rules, and project configuration apply. The extension does not enable following directory symlinks or override ignore rules.
- **Results:** Native output retains initial file paths and line numbers. Content is clipped to 2000 characters per line, then 500 lines or 30000 bytes, plus a short status/truncation notice. These are display limits, not match limits. No full-output file is saved. Narrow the path/pattern to retrieve omitted search or preview results. Never rerun an applied rewrite just to recover its output. Pi buffers CLI output in memory before truncation, so prefer narrow searches in large repositories.
- **Failures:** Each operation first validates `ast-grep --version`, because Pi can report a missing executable as an empty exit 1. Only a verified CLI run with empty stdout and stderr and exit 0 or 1 becomes “No matches found.” Other nonzero exits throw tool errors. Successful stderr diagnostics are retained.
- **Cancellation:** The tool abort signal and timeout reach both the version check and actual operation. Each process has its own timeout, so the complete invocation can take up to twice the requested timeout, plus mutation-queue waiting. Cancelled or timed-out rewrites may have already changed files. Failures are not rolled back. Inspect the working tree before retrying.

## Provenance

Adapted from [`dannote/dot-pi`, `extensions/ast-grep.ts`](https://github.com/dannote/dot-pi/blob/73fe0529c38f9a66fbf9a1b71c88d0d4980afceb/extensions/ast-grep.ts) at commit `73fe0529c38f9a66fbf9a1b71c88d0d4980afceb`, under MIT. This adaptation replaces upstream rendering and temporary-file diff generation, renames the tools, defaults rewrites to preview, and adds explicit file scope, safe execution, failure classification, bounds, and regression tests. The exact upstream license is included in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and shipped with the package.

## Development checks

From the monorepo root:

```sh
pnpm exec vitest run packages/ast-grep/index.test.ts
pnpm typecheck
```

Tests mock `pi.exec` for safety and failure cases. A real-CLI temporary-file test also runs when `ast-grep` is available, otherwise that test is skipped.
