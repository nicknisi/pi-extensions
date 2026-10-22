# @nicknisi/pi-cloak

Redacts secrets and other sensitive content from `read`, `bash`, and `grep` tool results before they enter model context. Rules are defined per-file-glob in a JSON config; when the agent reads a matching file, matched text is replaced with a masked string (e.g. `S********`) so credentials, tokens, and private values never reach the model while the agent can still see file structure and read around the masked regions.

## What it adds

- **Command:** `/cloak-status` — reloads the config and notifies with current status: `pi-cloak enabled=<bool> patterns=<n> config=<path>`, or the load error if the config is missing/invalid.
- **Event hooks:**
  - `session_start` — reloads config; notifies a warning if the config file is missing, failed to parse, or had rules skipped. Without a UI (print/RPC mode), parse errors and skipped rules are written to stderr; a missing config stays silent.
  - `tool_result` — intercepts results from the `read`, `bash`, and `grep` tools and rewrites text content parts in place. A rule applies when its `filePattern` matches the file the output came from: the `read` path, a file the `bash` command names (`cat .env`, `source ./.env.local`), or `grep`'s `path`/`glob`. Rules with `"global": true` apply to every `read`, `bash` and `grep` result. Other tools and non-text content parts pass through untouched. Returns `undefined` (no modification) when disabled, when no rule matches, or when nothing changed.
- **Config file:** `<agentDir>/cloak.json` (see below).
- **Exports (for other extensions/tests):** `loadState(configPath?)` and `cloakText(rawText, rawPaths, cwd, state)` are exported from `index.ts`. `rawPaths` is one path or a list; rules matching any of them, plus `global` rules, apply.

No tools, keybindings, widgets, or custom entry types.

## Install

```bash
pi install /Users/nicknisi/Developer/pi-extensions/packages/cloak
```

## Configuration

Config is read from `DEFAULT_CONFIG_PATH = join(getAgentDir(), "cloak.json")` — i.e. `~/.pi/agent/cloak.json` with a default pi setup. It is loaded at extension init and reloaded on `session_start` and `/cloak-status`. There is no live file watcher; edits take effect on the next session start or `/cloak-status`.

- **Missing file:** no rules; tool results pass through unchanged (a warning is shown on session start in UI sessions).
- **File exists but cannot be read or parsed** (e.g. invalid JSON): the extension **fails closed** — every `read`/`bash`/`grep` result is replaced with a `[pi-cloak: <tool> output withheld because the cloak config could not be loaded. …]` placeholder until the config is fixed and reloaded. The error is reported as above.
- **Invalid rule** (e.g. a bad regex): that rule is skipped and reported (`pi-cloak skipped rule #<n> …`); the other rules stay active.

### Top-level options

| Key              | Type                | Default | Description                                                                                                                                     |
| ---------------- | ------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`        | `boolean`           | `true`  | Master switch. When `false`, `cloakText` and the `tool_result` hook return input unchanged.                                                     |
| `cloakCharacter` | `string`            | `"*"`   | Fill character(s) used for the masked portion of a replacement. Repeated/sliced to length.                                                      |
| `cloakLength`    | `number \| null`    | `null`  | Fixed length for every masked replacement. When `null`, length is `max(match.length, visiblePrefix.length)` so masks preserve original length.  |
| `tryAllPatterns` | `boolean`           | `true`  | When `true`, every pattern in a rule is applied. When `false`, a line changed by one pattern is not touched by later patterns in the same rule. |
| `patterns`       | `CloakRuleConfig[]` | `[]`    | List of rules (see below).                                                                                                                      |

### Rule shape

```json
{
  "filePattern": "**/.env*",
  "cloakPattern": "^([A-Z0-9_]+)=(.+)$",
  "replace": "$1="
}
```

| Key            | Type                        | Required | Description                                                                                                                                                                                                                                                                                                                                                                             |
| -------------- | --------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filePattern`  | `string \| string[]`        | yes      | Glob(s) matched against the read path. Supports `*` (within a segment), `**` (across segments, `**/` also matches zero directories), and `?`. Matching is attempted against the raw path, the cwd-resolved absolute path, and each path's basename, so both `**/.env*` and `.env` work. A leading `@` on the read path is stripped; `~` is expanded; backslashes are normalized to `/`. |
| `cloakPattern` | `string \| object \| array` | yes      | Regex source string(s) applied to the whole text. Object form: `{ "pattern": string, "replace"?: string, "flags"?: string }`. The `g` and `m` flags are always added, so `^`/`$` anchor at line boundaries.                                                                                                                                                                             |
| `replace`      | `string`                    | no       | Rule-level default replacement template; a per-pattern `replace` overrides it.                                                                                                                                                                                                                                                                                                          |
| `global`       | `boolean`                   | no       | Apply this rule to every `read`, `bash` and `grep` result, not only to output from files matching `filePattern`. Use it for patterns specific enough to run on any output, such as known token prefixes (`sk-…`, `ghp_…`). Default `false`.                                                                                                                                             |

### Replacement semantics

Each match becomes `visiblePrefix + mask`:

- With a `replace` template, the visible prefix is the rendered template. Supported substitutions: `$&` (whole match), `$1`–`$99` (capture groups), `$$` (literal `$`). Unknown `$x` sequences are passed through literally.
- Without `replace`, the visible prefix is the first character of the match (e.g. `hunter2` → `h*******`).
- The remainder is padded with `cloakCharacter` up to `cloakLength`, or to `max(match.length, visible.length)` when `cloakLength` is `null`. If the visible prefix is already longer than the target length, it is truncated and no mask is added.
- Text outside matches (including `\r\n` line endings) is preserved. A match spanning lines is masked as one unit, so its line breaks are masked too. If nothing changed, the original text is returned unmodified.

### Full example (`~/.pi/agent/cloak.json`)

```json
{
  "enabled": true,
  "cloakCharacter": "*",
  "cloakLength": null,
  "tryAllPatterns": true,
  "patterns": [
    {
      "filePattern": ["**/.env", "**/.env.*"],
      "cloakPattern": {
        "pattern": "^([A-Z0-9_]+)=(.+)$",
        "replace": "$1="
      }
    },
    {
      "filePattern": "**/*.pem",
      "cloakPattern": ".+"
    },
    {
      "filePattern": "**/credentials.json",
      "cloakPattern": [
        { "pattern": "\"(private_key|client_secret)\":\\s*\"([^\"]+)\"", "replace": "\"$1\": \"" },
        { "pattern": "-----BEGIN [A-Z ]+-----.*?-----END [A-Z ]+-----", "flags": "s" }
      ],
      "replace": ""
    }
  ]
}
```

Effect: in `.env` files `API_KEY=sk-abc123` becomes `API_KEY=*********`; in `.pem` files every non-empty line becomes `x********...`; in `credentials.json` named fields keep their key and quote prefix with the value masked, and multi-line PEM blocks are masked whole.

## Usage

```text
/cloak-status
```

Typical workflow: add rules to `~/.pi/agent/cloak.json`, run `/cloak-status` in a session to reload and verify the pattern count, then any `read` of a matching file, and any `bash`/`grep` output from a matching file (or matching a `global` rule), is masked before the model sees it.

## Dependencies

- `@earendil-works/pi-coding-agent` (peer, `*`) — `ExtensionAPI` type and `getAgentDir()`; relies on the extension event API (`pi.on`, `pi.registerCommand`) and the `tool_result` event contract (`event.toolName`, `event.input.path`, mutable `content` parts).
- Node built-ins only otherwise: `node:fs`, `node:os`, `node:path`. No npm runtime dependencies, no workspace deps.

## Caveats

- **Only `read`, `bash`, and `grep` are cloaked.** `bash` output is matched to rules only through the file names its command mentions, so a secret printed without naming its file (`env`, `printenv`, `rg API_KEY`) is masked only by `global` rules; keep `global` patterns specific enough not to mask unrelated output. Content reaching the model via `edit` diffs, other tools, or encodings your patterns don't match (e.g. `base64 .env`) is not masked. Rules that depend on secrecy should assume shell access can bypass the cloak.
- Depends on the `tool_result` event returning `{ content }` to mutate results, and on `event.input.path` being a string — both are pi internals that could change across versions.
- Regexes are compiled with `new RegExp(spec)` directly from config, one rule at a time; a rule with an invalid regex is skipped and reported, the rest stay active.
- Patterns run over the whole text. `.` does not cross line breaks unless you add the `s` flag, but `\s`, `\n`, and negated classes like `[^"]` can; use a lazy quantifier (`.*?`) for block patterns so one match doesn't swallow everything between the first BEGIN and the last END.
- Glob matching is a hand-rolled `globToRegExp`, not a full glob library — no character classes (`[...]`) or brace expansion.
- The masked output length can leak the original secret length when `cloakLength` is `null` (default). Set `cloakLength` to a fixed number to avoid this.
- Config is not hot-reloaded on file change; reload requires a new session or `/cloak-status`.
- Package name is `@nicknisi/pi-cloak`, private, single-file extension. (Directory renamed `cloak`; package name kept.)
