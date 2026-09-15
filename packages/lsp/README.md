# @nicknisi/pi-lsp

Owned, read-only TypeScript and JavaScript language intelligence for Pi. There is no dependency on dot-pi or any other Pi extension. Runtime library dependencies are `typebox` and `vscode-jsonrpc`.

## Installation

```sh
pi install npm:@nicknisi/pi-lsp
```

Install `typescript-language-server` and `typescript` separately in a trusted global location. For example, explicitly run `npm install -g typescript-language-server typescript`. This extension never installs software or searches a repository's `node_modules/.bin` for executables. For a dedicated install, use a directory such as `~/.pi/agent/language-servers/typescript-lsp`. Do not use `~/.pi/agent/tools/`, which Pi reserves for legacy custom tools and flags at startup.

Pi must provide `ctx.isProjectTrusted()`. Older hosts without that API fail closed. Trust the current project through Pi before using the tool. No server is started during extension loading.

## Tool

The single `lsp` tool accepts:

| Field    | Required           | Meaning                                                          |
| -------- | ------------------ | ---------------------------------------------------------------- |
| `action` | yes                | `definition`, `references`, `hover`, `symbols`, or `diagnostics` |
| `file`   | yes                | Existing TS/JS file, relative to `ctx.cwd` or absolute inside it |
| `line`   | positional actions | 1-based line                                                     |
| `column` | positional actions | 1-based UTF-16 column, like LSP/editor positions                 |

Supported suffixes are `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, and `.cjs`, including declaration files. `symbols` means document symbols, not workspace search. References include the declaration.

```json
{ "action": "definition", "file": "src/main.ts", "line": 12, "column": 8 }
```

```json
{ "action": "hover", "file": "src/main.ts", "line": 12, "column": 8 }
```

```json
{ "action": "references", "file": "src/main.ts", "line": 12, "column": 8 }
```

```json
{ "action": "symbols", "file": "src/main.ts" }
```

```json
{ "action": "diagnostics", "file": "src/main.ts" }
```

Results retain readable LSP JSON fields and file URIs. All returned positions are converted to 1-based `line` and `column`. Output is limited to 100 entries per array, 20 levels of nesting, 800 lines, and 24,000 bytes before a short limit notice. No full-output temporary file is written. Input files must be regular files of at most 2 MiB.

## Global configuration

Only Pi's global `configs/lsp.json` is read, normally `~/.pi/agent/configs/lsp.json`. A custom `PI_CODING_AGENT_DIR` is respected. No project extension config is read or merged. The complete schema is an object with these optional fields. Unknown top-level fields and invalid values are errors.

```json
{
  "command": "typescript-language-server",
  "args": ["--stdio"],
  "initializationOptions": {},
  "timeoutMs": 15000
}
```

| Field                   | Type and validation                                                                                       | Default                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `command`               | Nonempty executable basename or absolute path, no NUL. Relative paths containing separators are rejected. | `typescript-language-server` |
| `args`                  | Array of strings without NUL, passed literally without a shell                                            | `["--stdio"]`                |
| `initializationOptions` | JSON object forwarded to the server during initialize                                                     | `{}`                         |
| `timeoutMs`             | Integer from 100 through 120000, per protocol request or diagnostic wait                                  | `15000`                      |

Missing config uses defaults. Invalid JSON fails explicitly. Config is read when a server is created. Use `/reload` to apply changes to a running server. No environment substitution, shell expansion, or `~` expansion is performed inside config values.

A basename is resolved only through absolute PATH entries whose canonical directories and executable targets are outside the current project. An absolute command in this global config is explicit user authorization, including if it points inside a project.

Pin the TypeScript implementation through the server's initialization options when reproducibility or avoiding project TypeScript selection matters:

```json
{
  "command": "/Users/nicknisi/.pi/agent/language-servers/typescript-lsp/node_modules/.bin/typescript-language-server",
  "args": ["--stdio"],
  "initializationOptions": {
    "tsserver": {
      "path": "/Users/nicknisi/.pi/agent/language-servers/typescript-lsp/node_modules/typescript/lib/tsserver.js"
    }
  },
  "timeoutMs": 15000
}
```

The options object's nested schema belongs to `typescript-language-server`, not this extension. Do not place commands or options from untrusted repositories in global config.

## Lifecycle and diagnostics

One server is lazily reused per canonical cwd. Calls are serialized to prevent overlapping document snapshots. Every operation rereads the target and all previously opened documents and sends changed contents before querying. Changes made with external editors or Pi tools are therefore visible without reloading. Deleted or newly disallowed open documents fail explicitly rather than silently retaining stale contents. Restart with `/reload` to clear those documents.

Diagnostics use TypeScript language server's push publications. The tool forces a document update, waits for a fresh publication, then waits 1500ms for a quiet snapshot. Short configured timeouts may expire before that quiet period completes. Versioned stale publications are ignored. Unversioned servers cannot prove exact snapshot freshness. A snapshot is not a guarantee of completed project analysis, and a timeout is an error, never a clean result. No diagnostics are injected after edit/write calls, and there is no system-prompt hook or custom rendering.

Errors distinguish `LSP_UNTRUSTED`, `LSP_PATH`, `LSP_LANGUAGE`, `LSP_POSITION`, `LSP_FILE`, `LSP_CONFIG`, `LSP_EXECUTABLE`, `LSP_PROCESS`, `LSP_PROTOCOL`, `LSP_CANCELLED`, `LSP_TIMEOUT`, and `LSP_SHUTDOWN`. Native filesystem and server protocol errors may also surface. Aborted and timed-out requests send JSON-RPC cancellation. Diagnostic waits are local notification waits, so cancellation only stops waiting. Session shutdown attempts protocol shutdown/exit, then terminates the child with a bounded forced-kill fallback.

## Security and limits

The tool does not write files, rename symbols, request code actions, format documents, execute workspace commands, or apply edits. It advertises `workspace.applyEdit: false` and explicitly answers server `workspace/applyEdit` requests with `applied: false`. Other server requests are rejected as unsupported.

Trust is checked before project/config reads or spawning. The boundary is canonical `ctx.cwd`, not a discovered git root. Traversal and symlinks pointing outside it are refused. This is not an OS sandbox or protection against concurrent hostile filesystem replacement. Returned server locations may refer outside the project, such as installed TypeScript libraries. The tool does not open those locations.

**A trusted language server still has full OS access.** It can read project configuration, dependencies, imported files outside cwd, and sensitive files, and can execute code or write files on its own. TypeScript server selection and plugin behavior are controlled by that external server. Trust both the server and project. Read-only describes this tool's protocol surface, not a security sandbox for the child process.

Cloak and other read-only/redaction extensions may only intercept stock `read` or mutation tools. They do not automatically cover `lsp` results or the server's direct filesystem access. Treat hover text, diagnostics, symbol names, and server messages as potentially sensitive, untrusted project content.

The implementation targets local POSIX environments and stock Pi rendering. It does not provide remote filesystem support, a server catalog, auto-installation, background diagnostic hooks, or automatic restart/retry of failed calls. A later call can recreate a failed server.

## Development

```sh
pnpm exec vitest run packages/lsp/lsp.test.ts
PI_LSP_REAL_TEST=1 pnpm exec vitest run packages/lsp/lsp.test.ts
```

The opt-in real fixture currently uses the absolute server and TypeScript paths shown above. It was tested against TypeScript 5.9.3. Unit tests cover trust, containment, read-only request rejection, process failure, cancellation, timeout, and output bounds. The real fixture covers all protocol actions and changed-file synchronization.

Adapted from dot-pi's `extensions/lsp` snapshot at commit `73fe0529c38f9a66fbf9a1b71c88d0d4980afceb`, replacing the parser and mutable feature surface with this package's owned implementation. See the shipped `THIRD_PARTY_NOTICES.md` for the exact upstream MIT license.
