# @nicknisi/pi-session-name

Name pi sessions so they're easy to search and resume. Pi's built-in `/name` works but requires you to remember to use it; this extension derives a concise name automatically as soon as the first prompt is sent (heuristic by default, LLM-generated opt-in), mirrors the name into the terminal/window title, and adds `/sn` for manual naming and `/sessions` for a name-focused search-and-resume picker. Sessions already named via `/sn`, `/name`, or `--name` are never overwritten.

## What it adds

- **Commands**
  - `/sn [name]` — Set the session name. With no argument, shows the current name via `ctx.ui.notify`. `/sn clear` (also `-c`, `--clear`) clears it. A name that is empty after removing control characters is rejected with an error. Argument completion suggests `clear`.
  - `/sessions [query] [--all]` — Interactive picker of sessions for the current project (`SessionManager.list(ctx.cwd)`), or across every project with `--all` / `-a` (`SessionManager.listAll()`). Selecting an entry resumes that session via `ctx.switchSession`. Requires interactive mode (`ctx.hasUI`).
- **Terminal title** — Sets the window/tab title via `ctx.ui.setTitle` to reflect the session name (e.g. `fix login bug — dotfiles`). Reaches whatever pi's terminal layer drives (Ghostty, tmux panes, etc.).
- **Auto-naming** — When the first prompt of an unnamed session starts a run (`before_agent_start`), derives a name from that prompt (heuristic mode) or a one-off LLM call (llm mode), then calls `pi.setSessionName`. Runs alongside the agent rather than delaying it. Fires at most once per session instance. A prompt with fewer than three words (`ok`, `hello`) is skipped and the next prompt gets another try, so a session isn't named "Empty start".
- **Auto-renaming** — When a decision model (classifier, e.g. TypeSafe's Jev) is available, every few user prompts it asks whether the work has moved on to a different task than the current name describes, and renames the session when it has. Only names this extension set are eligible; names from `/sn`, `/name`, or `--name` are never touched. See [How auto-renaming works](#how-auto-renaming-works).

## Events hooked

| Event                  | Purpose                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `session_start`        | Resets the auto-name guard; defers a title set (via `setTimeout(0)`) so it runs after pi's built-in `updateTerminalTitle()` on startup. |
| `session_info_changed` | Re-sets the title. `setSessionName` emits to built-in handlers first, so this runs after pi's built-in title update and wins.           |
| `session_shutdown`     | Aborts any in-flight LLM title call and clears the pending title timer so a resolved name never lands on a torn-down/replaced session.  |
| `before_agent_start`   | Triggers auto-naming when the first prompt is sent, without blocking the run. Counts user prompts for the auto-rename check.            |
| `agent_settled`        | Runs the auto-rename drift check every `renameEvery` user prompts, without blocking anything.                                           |

No custom tools, keybindings, widgets, or message types. Two custom entry types, neither sent to the model: `session-name-cleared` (written by `/sn clear`) and `session-name-auto` (written whenever this extension sets a name, so it knows later which names it may rename).

## Usage

```
/sn refactor auth flow        # name the current session
/sn                           # show the current name
/sn clear                     # clear it (won't be re-auto-named, even after /reload or resume)

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
| `autoName`           | `"off" \| "heuristic" \| "llm"` | `"heuristic"`         | Naming mode, applied when the first prompt is sent. `heuristic` uses the first non-empty line of the first user message (free, instant). `llm` makes a one-off title-generation call and falls back to the heuristic if it fails. `off` disables auto-naming.                      |
| `heuristicMaxLength` | `number`                        | `60`                  | Max characters for derived names (applies to both heuristic and LLM titles; longer names are truncated with `…`).                                                                                                                                                                  |
| `llmMaxWords`        | `number`                        | `6`                   | Max words requested in the LLM title-generation prompt.                                                                                                                                                                                                                            |
| `llmModel`           | `string \| null`                | `null`                | Model for LLM titles as `"provider/model-id"`, e.g. `"anthropic/claude-haiku-4-5"`. `null` uses the session model. If unavailable with working credentials, falls back to the current session model and warns once.                                                                |
| `notifyOnAutoName`   | `boolean`                       | `true`                | Show a `Session named: …` notification when auto-naming succeeds.                                                                                                                                                                                                                  |
| `setTitle`           | `boolean`                       | `true`                | Mirror the session name into the terminal/window title.                                                                                                                                                                                                                            |
| `titleFormat`        | `string`                        | `"{summary} — {dir}"` | Title template. Placeholders: `{summary}` (session name), `{dir}` (basename of cwd) and `{app}` (what the host calls itself — `π`, or the brand name under a rebranded distribution such as `arc`). When the session is unnamed the title is `{app} — {dir}` regardless of format. |
| `autoRename`         | `boolean`                       | `true`                | Rename auto-named sessions when the work moves on to a different task. Only runs when a model from `renameModels` has credentials, and never when `autoName` is `"off"`.                                                                                                           |
| `renameEvery`        | `number`                        | `3`                   | User prompts between drift checks. Must be a positive integer.                                                                                                                                                                                                                     |
| `renameThreshold`    | `number`                        | `0.85`                | Classifier probability (0 to 1) that the task changed, needed to rename.                                                                                                                                                                                                           |
| `renameModels`       | `string[]`                      | Jev on every provider | Classifier models as `"provider/model-id"`; the first one with credentials is used. Defaults to `DEFAULT_CLASSIFIERS` from `@nicknisi/pi-shared` (`typesafe/jev-latest`, then Jev on OpenRouter, Cloudflare, Vercel and OpenCode).                                                 |

Example (`session-name.example.json`):

```json
{
  "autoName": "heuristic",
  "heuristicMaxLength": 60,
  "llmMaxWords": 6,
  "llmModel": null,
  "notifyOnAutoName": true,
  "setTitle": true,
  "titleFormat": "{summary} — {dir}",
  "autoRename": true,
  "renameEvery": 3,
  "renameThreshold": 0.85
}
```

No environment variables are read.

LLM selection uses `selectSideModel` from `@nicknisi/pi-shared`, checking the preferred provider's available chat models. Missing credentials or a failed lookup falls back to the current session model, freshly selected for each naming attempt. IDs may contain slashes. With no model, naming uses the heuristic. Actual request failures also keep the existing heuristic fallback, not a retry on another model. Shutdown cancels selection and prevents pending auth/title results from naming a replaced session; OAuth auth remains supported.

## How auto-naming works

1. On `before_agent_start`, skip if already named (via `/sn`, `/name`, `--name`, or a prior auto-name), if `autoName` is `"off"`, or if the run was started by a custom message rather than a user prompt. Slash commands never start a run, so they never trigger naming.
2. Use the first user message already in the branch that has at least three words (`ctx.sessionManager.getBranch()`, so a resumed unnamed session is named from its first real prompt), else the prompt being sent if it has three words. Otherwise wait for the next prompt. A skill invocation (`/skill:name args`) arrives expanded into a `<skill …>` block; naming uses its args, or the skill name when the args are missing or under three words, never the skill body. Naming then runs in the background; the agent run does not wait for it.
3. Heuristic mode: first non-empty line, whitespace-collapsed, truncated to `heuristicMaxLength`.
4. LLM mode: one `ctx.modelRegistry.complete()` call (applies `models.json` overrides, extension-registered providers, and request-time auth) with a system prompt asking for a ≤ `llmMaxWords`-word title, fed the first user prompt (truncated to 1000 chars). The response is cleaned (first line; leading `#`, `**`/`__` emphasis around words (not inside identifiers like `foo__bar`), quotes and trailing punctuation stripped) and truncated to `heuristicMaxLength`. A `ctx.modelRegistry.getApiKeyAndHeaders(model)` pre-check falls back to the heuristic when no API key is available.
5. A name manually set while the LLM call is in flight wins — the result is discarded. So does a session replaced or shut down meanwhile.
6. Manually naming or clearing a session sets the per-session guard so auto-naming never fires afterward in that session instance. `/sn clear` also appends a `session-name-cleared` custom entry to the session, so the opt-out survives `/reload` and resume.

Every name, from either mode or `/sn`, has control and bidi characters replaced with spaces before it's saved, and the terminal title is cleaned the same way. Pi writes the title inside an escape sequence, so a stray ESC or BEL in a name could otherwise break out of it.

## How auto-renaming works

1. Every name this extension sets is recorded with a `session-name-auto` custom entry. A session is eligible for renaming only while its current name matches the latest such entry, so a name set with `/sn`, `/name`, or `--name` (or a cleared name) is never renamed, including after `/reload` and resume. Sessions named before this feature have no entry and are left alone.
2. Each user prompt in a named session counts toward `renameEvery`. When the run settles (`agent_settled`, skipped if aborted) and the count is reached, the count resets and a check runs in the background.
3. The check sends the classifier the current name, the last three task-stating user prompts, and the start of the last assistant reply, and asks whether the work moved on to a different task. Related subtasks, follow-ups, fixes and reviews of the same work count as the same task.
4. At or above `renameThreshold`, a new name is generated the same way as the first one: an LLM title from the recent prompts in `llm` mode, else the first line of the latest prompt. If the name changed in the meantime, or the new name equals the old one, nothing happens.
5. The rename shows `Session renamed: …` when `notifyOnAutoName` is on. Shutdown cancels a pending check.

## Dependencies

- `@nicknisi/pi-shared` — optional side-model selection, and `findClassifier`/`classifyBool` for the auto-rename check. Older supported hosts without `getAvailableOfType()` use `find()` plus `getApiKeyAndHeaders()`.

- `@earendil-works/pi-coding-agent` (peer, `>=0.86.0`) — `ExtensionAPI`, `ExtensionContext`, `SessionEntry`, `SessionInfo`, `SessionManager` (used for `list`/`listAll` in `/sessions`).
- `@earendil-works/pi-ai` (peer) — `Message` type for the LLM title request.
- Node builtins: `node:fs`, `node:path`.

## Caveats

- Depends on pi internals' event ordering: the title logic assumes built-in handlers (`updateTerminalTitle`) run before extension handlers for `session_start` and `session_info_changed`, and uses a `setTimeout(0)` deferral on startup to win the race. A pi release that changes handler ordering could revert titles to pi's default format.
- LLM title generation relies on `ctx.modelRegistry.complete()` (`stopReason`, text content blocks) and `ctx.modelRegistry.getApiKeyAndHeaders`.
- `/sessions` excludes the current session by comparing `SessionInfo.path` to `ctx.sessionManager.getSessionFile()`.
- Clearing the name via pi's built-in `/name` (empty) does not set the auto-name guard — only `/sn clear` does — so a cleared-via-`/name` session may be auto-named again on the next turn.
- Auto-renaming changes the session name mid-session. Anything that addresses a session by its exact name, such as `pi-relay` targets, stops matching after a rename; use relay's `@alias` for a stable address, or set `autoRename: false`.
- On hosts without `agent_settled` or classifier support, auto-renaming silently never runs.
- Title behavior depends on the terminal honoring pi's title escape sequences (works in Ghostty and tmux panes as noted in the source header).

## Install

```sh
pi install /Users/nicknisi/Developer/pi-extensions/packages/session-name
```
