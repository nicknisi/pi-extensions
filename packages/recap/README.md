# @nicknisi/pi-recap

Auto-recap card for pi. When a TUI session sits idle for a configurable number of minutes, this extension summarizes the current conversation branch with an LLM call and injects the result into the transcript as a dimmed, capped-height card. Useful when you come back to a session after stepping away and want a quick "where was I" without re-reading the whole transcript.

## What it adds

- Commands: `/recap`, `/recap-idle`
- Entry type: `recap` (with a registered renderer)
- Event hooks: `session_start`, `before_agent_start`, `agent_settled`, `session_shutdown`
- Background timer (30s tick) that detects idle and fires the recap
- No tools, keybindings, or overlays

## Behavior

Idle is tracked via `lastActivity`, reset by `before_agent_start` and `agent_settled` (i.e. any agent run counts as activity). Every 30 seconds the timer checks:

1. `ctx.isIdle()` — agent not running
2. `firedThisIdle` — only one recap per idle period (reset on next activity)
3. Elapsed time since `lastActivity` >= `idleMinutes`
4. Branch length >= 4 entries (skips trivial sessions)

If all pass, it builds a plain-text transcript of the current branch (user/assistant text plus one line per tool call: `Tool <name> called with <args JSON>`), sends it to the model with a "summarize tersely, 6-8 lines, short markdown headings" prompt, and appends the result as a `recap` entry via `pi.appendEntry`.

The renderer draws a `Box` containing a bold "Recap · <time>" header and the summary as Markdown, capped at 5 lines (truncated with ` …`). The card is dimmed and given a hardcoded truecolor background (`#131320`) so it reads as distinct from user/assistant messages.

## Usage

```
/recap              # generate and inject a recap now
/recap-idle 5       # set idle threshold to 5 minutes (persisted)
/recap-idle abc     # rejected with a usage warning
```

## Configuration

Config file: `~/.pi/agent/configs/recap.json` (created on first `/recap-idle` write; read on every tick and every generation).

```json
{
  "idleMinutes": 3,
  "model": { "provider": "anthropic", "id": "claude-haiku-4-5" }
}
```

| Option        | Type                               | Default                     | Notes                                                                                        |
| ------------- | ---------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------- |
| `idleMinutes` | number                             | `3`                         | Minutes of inactivity before an auto-recap fires. Set via `/recap-idle`.                     |
| `model`       | `{ provider: string; id: string }` | session model (`ctx.model`) | Optional override. If omitted or not registered in Pi, recap uses the current session model. |

No environment variables are read.

## Constants (not configurable)

- `TICK_MS = 30_000` — idle check interval
- `MIN_BRANCH_LEN = 4` — minimum session entries before auto-firing
- `MAX_CARD_LINES = 5` — rendered summary line cap
- Summarization call runs with `reasoningEffort: "low"`, `cacheRetention: "none"`

## Dependencies

Peer deps (all `@earendil-works/*`, provided by the pi host):

- `@earendil-works/pi-ai` — `uuidv7` (session id for the completion call)
- `@earendil-works/pi-coding-agent` — `ExtensionAPI`, `getMarkdownTheme`; uses `pi.registerCommand`, `pi.registerEntryRenderer`, `pi.appendEntry`, `pi.on`, `ctx.sessionManager.getBranch`, `ctx.modelRegistry.complete`, `ctx.isIdle`, `ctx.ui.notify`
- `@earendil-works/pi-tui` — `Box`, `Text`, `Markdown` for the card renderer

No npm runtime deps, no workspace deps.

## Caveats

- TUI only: the timer and renderer are installed in `session_start` only when `ctx.mode === "tui"`. `/recap` technically works in other modes but nothing renders the entry there.
- Depends on several pi internals that could change across versions: `sessionManager.getBranch()`, `modelRegistry.complete()`, `ctx.isIdle()`, and the `session_start`/`before_agent_start`/`agent_settled` event names.
- A configured model is resolved and completed through `ctx.modelRegistry`, so registered custom providers work. An omitted or unresolved override falls back to the current session model.
- Background recap failures are reported as warnings and never terminate the pi process.
- The card background is a hardcoded truecolor escape (`#131320`) chosen to sit darker than the tokyonight base/message backgrounds (`theme.bg` only accepts named tokens). With other themes it may clash.
- Entry content extraction is structural (filters blocks by `type === "text"` / `type === "toolCall"`), so changes to pi's message block shape would silently empty the transcript it summarizes.
- The timer is cleared on `session_shutdown`; if a session never shuts down cleanly the interval lives until process exit.

## Install

```bash
pi install /Users/nicknisi/Developer/pi-extensions/packages/recap
```
