# @nicknisi/pi-session-name

Name pi sessions so they're easy to search and resume. Pi's built-in `/name` works but requires you to remember to use it; this extension derives a concise name automatically after the first exchange (heuristic by default, LLM-generated opt-in), mirrors the name into the terminal/window title, and adds `/sn` for manual naming and `/sessions` for a name-focused search-and-resume picker. Sessions already named via `/sn`, `/name`, or `--name` are never overwritten.

## What it adds

- **Commands**
  - `/sn [name]` — Set the session name. With no argument, shows the current name via `ctx.ui.notify`. `/sn clear` (also `-c`, `--clear`) clears it. Argument completion suggests `clear`.
  - `/sessions [query] [--all]` — Interactive picker of sessions for the current project (`SessionManager.list(ctx.cwd)`), or across every project with `--all` / `-a` (`SessionManager.listAll()`). Selecting an entry resumes that session via `ctx.switchSession`. Requires interactive mode (`ctx.hasUI`).
- **Terminal title** — Sets the window/tab title via `ctx.ui.setTitle` to reflect the session name (e.g. `fix login bug — dotfiles`). Reaches whatever pi's terminal layer drives (Ghostty, tmux panes, etc.).
- **Auto-naming** — On the first `agent_settled` event in an unnamed session, derives a name from the first user message (heuristic mode) or a one-off LLM call (llm mode), then calls `pi.setSessionName`. Fires at most once per session instance.

## Events hooked

| Event                  | Purpose                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `session_start`        | Resets the auto-name guard; defers a title set (via `setTimeout(0)`) so it runs after pi's built-in `updateTerminalTitle()` on startup. |
| `session_info_changed` | Re-sets the title. `setSessionName` emits to built-in handlers first, so this runs after pi's built-in title update and wins.           |
| `session_shutdown`     | Aborts any in-flight LLM title call and clears the pending title timer so a resolved name never lands on a torn-down/replaced session.  |
| `agent_settled`        | Triggers auto-naming after the first exchange.                                                                                          |

No custom tools, keybindings, widgets, or message/entry types.

## Usage

```
/sn refactor auth flow        # name the current session
/sn                           # show the current name
/sn clear                     # clear it (won't be re-auto-named)

/sessions                     # picker: all sessions in this project
/sessions auth                # filter by name, first message, or session id
/sessions auth --all          # search across every project
```

The picker lists sessions as:

```
★ fix login bug  — 42 msgs — 2h ago — a1b2c3d4
· (first message preview…)  — 5 msgs — 3d ago — e5f6g7h8
```

Named sessions (`★`) sort first, then most recently modified. The current session is excluded from the list.

## Configuration

Config file: `~/.pi/agent/configs/session-name.json` (JSON, all keys optional; missing file or parse errors fall back to all defaults). An example lives at `session-name.example.json` in this package.

| Key                  | Type                            | Default               | Description                                                                                                                                                                                                                                                                        |
| -------------------- | ------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoName`           | `"off" \| "heuristic" \| "llm"` | `"heuristic"`         | Naming mode after the first exchange. `heuristic` uses the first non-empty line of the first user message (free, instant). `llm` makes a one-off title-generation call and falls back to the heuristic if it fails. `off` disables auto-naming.                                    |
| `heuristicMaxLength` | `number`                        | `60`                  | Max characters for derived names (applies to both heuristic and LLM titles; longer names are truncated with `…`).                                                                                                                                                                  |
| `llmMaxWords`        | `number`                        | `6`                   | Max words requested in the LLM title-generation prompt.                                                                                                                                                                                                                            |
| `llmModel`           | `string \| null`                | `null`                | Model for LLM titles as `"provider/model-id"`, e.g. `"anthropic/claude-haiku-4-5"`. `null` uses the session model. If the configured model isn't found in the registry, falls back to the session model and warns once.                                                            |
| `notifyOnAutoName`   | `boolean`                       | `true`                | Show a `Session named: …` notification when auto-naming succeeds.                                                                                                                                                                                                                  |
| `setTitle`           | `boolean`                       | `true`                | Mirror the session name into the terminal/window title.                                                                                                                                                                                                                            |
| `titleFormat`        | `string`                        | `"{summary} — {dir}"` | Title template. Placeholders: `{summary}` (session name), `{dir}` (basename of cwd) and `{app}` (what the host calls itself — `π`, or the brand name under a rebranded distribution such as `arc`). When the session is unnamed the title is `{app} — {dir}` regardless of format. |

Example (`session-name.example.json`):

```json
{
  "autoName": "heuristic",
  "heuristicMaxLength": 60,
  "llmMaxWords": 6,
  "llmModel": null,
  "notifyOnAutoName": true,
  "setTitle": true,
  "titleFormat": "{summary} — {dir}"
}
```

No environment variables are read.

## How auto-naming works

1. On `agent_settled`, skip if already named (via `/sn`, `/name`, `--name`, or a prior auto-name) or if `autoName` is `"off"`.
2. Grab the branch via `ctx.sessionManager.getBranch()` and extract the first user message text (string content or `text` content blocks).
3. Heuristic mode: first non-empty line, whitespace-collapsed, truncated to `heuristicMaxLength`.
4. LLM mode: one streaming call with a system prompt asking for a ≤ `llmMaxWords`-word title, fed the first user prompt (truncated to 1000 chars) and the start of the first assistant reply (800 chars). The response is cleaned (first line, quotes and trailing punctuation stripped) and truncated to `heuristicMaxLength`. Auth comes from `ctx.modelRegistry.getApiKeyAndHeaders(model)`; if no API key is available, falls back to the heuristic.
5. A name manually set while the LLM call is in flight wins — the result is discarded.
6. Manually naming or clearing a session sets the per-session guard so auto-naming never fires afterward in that session instance.

## Dependencies

- `@earendil-works/pi-coding-agent` (peer) — `ExtensionAPI`, `ExtensionContext`, `SessionEntry`, `SessionInfo`, `SessionManager` (used for `list`/`listAll` in `/sessions`).
- `@earendil-works/pi-ai` (peer) — `Message` type for the LLM title request.
- `@nicknisi/pi-shared` (workspace) — `getModelProvider(ctx, model)`, which resolves the composed runtime provider from `ctx.modelRegistry` (honoring `models.json` overrides and extension-registered providers) for the LLM title stream.
- Node builtins: `node:fs`, `node:os`, `node:path`.

## Caveats

- Depends on pi internals' event ordering: the title logic assumes built-in handlers (`updateTerminalTitle`) run before extension handlers for `session_start` and `session_info_changed`, and uses a `setTimeout(0)` deferral on startup to win the race. A pi release that changes handler ordering could revert titles to pi's default format.
- LLM title generation relies on the provider API shape (`provider.stream(...).result()`, `stopReason`, text content blocks) and `ctx.modelRegistry.getApiKeyAndHeaders` — both subject to change across pi versions.
- `/sessions` excludes the current session by comparing `SessionInfo.path` to `ctx.sessionManager.getSessionFile()`.
- Clearing the name via pi's built-in `/name` (empty) does not set the auto-name guard — only `/sn clear` does — so a cleared-via-`/name` session may be auto-named again on the next turn.
- Title behavior depends on the terminal honoring pi's title escape sequences (works in Ghostty and tmux panes as noted in the source header).

## Install

```sh
pi install /Users/nicknisi/Developer/pi-extensions/packages/session-name
```
