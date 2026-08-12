# @nicknisi/pi-statusline

Custom footer for pi's TUI, replacing the default footer with a single-line statusline showing model, session cost, lines changed, Anthropic usage limits, context window usage, and git branch/PR. Also writes tmux status files (`working`/`done`/`idle`) to `~/.cache/pi-status/` so tmux sidebars and other tooling can display per-pane agent state.

## Install

```sh
pi install /Users/nicknisi/Developer/pi-extensions/packages/statusline
```

## What it adds

- **Custom footer** — installed via `ctx.ui.setFooter(...)` on `session_start`. Single line, segments separated by `│`:
  - Model icon + name (nerd font icon chosen by name: opus/sonnet/haiku get distinct glyphs, everything else a generic robot icon). Appends the thinking level (e.g. `high`) when `ctx.model.reasoning` is true, read live from `pi.getThinkingLevel()`.
  - Session cost (`$X.XX`), summed from `AssistantMessage.usage.cost.total` across the current branch. Hidden until cost > $0.001.
  - Lines changed (`+N/-M`), summed from `linesAdded`/`linesRemoved` in toolResult `details` (i.e. the edit tool). Hidden when zero.
  - Anthropic usage limits (Anthropic models only): remaining-% bars for the 5-hour and 7-day OAuth usage windows, with time-until-reset (`↻3h20m`).
  - Context window usage: a bar that stretches to fill remaining terminal width (clamped 5–40 cols), plus `N% ctx (tokens)`.
  - Git branch (right-aligned), with a hyperlinked `#PR` number when `gh` finds an open PR for the branch.
- **Tmux status files** — JSON state files at `~/.cache/pi-status/<pane>.status` for external consumers (tmux sidebars, fleet monitors).

There are no slash commands, tools, keybindings, widgets, or custom message/entry types.

### Events hooked

| Event                   | Action                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `session_start`         | Installs the footer; writes `idle` status                                                     |
| `agent_start`           | Writes `working` status                                                                       |
| `tool_execution_start`  | Writes `working` status with `toolName`                                                       |
| `turn_start`            | Re-writes `working` to keep the status-file timestamp fresh during long tool-less generations |
| `agent_end`             | Writes `done` status; spawns `claude-notify waiting <session> <pane>` (detached)              |
| `session_shutdown`      | Removes the pane's status file                                                                |
| `thinking_level_select` | Triggers a footer re-render so the new level shows immediately                                |

## Tmux status files

Path: `~/.cache/pi-status/<pane>.status` where `<pane>` is `TMUX_PANE` with the leading `%` stripped.

```json
{
  "state": "working",
  "pane": "%12",
  "session": "main",
  "tool": "edit",
  "ts": 1717600000
}
```

- `state` is one of `working`, `done`, `idle` (the function signature also accepts `completed`, unused in practice).
- `tool` is the tool name from `tool_execution_start`, else `""`.
- `ts` is a unix timestamp; external consumers can treat a stale `working` state as idle (the code comments mention a 180s decay in "fleet").
- The tmux session name is resolved with `tmux display-message -p '#{session_name}'`, falling back to parsing the socket path in `$TMUX`.
- No-op when `TMUX_PANE` is unset. All write/remove failures are swallowed so they can't break the agent.

## Usage-limit segment (Anthropic only)

Shows remaining capacity for the 5-hour and 7-day rate-limit windows when `ctx.model.provider === "anthropic"`:

```
󰉁 5h ━━━╌╌ 62% ↻2h10m ╱ 7d ━━╌╌╌ 41% ↻3d4h
```

Data comes from `https://api.anthropic.com/api/oauth/usage` (header `anthropic-beta: oauth-2025-04-20`). The render path never does network or keychain I/O:

- Fresh cache (`< 120s`) in `$TMPDIR/pi-statusline-cache/usage.json` is rendered as-is.
- Stale/missing cache renders stale data (or nothing) and kicks a fire-and-forget `curl` refresh that re-renders the footer on completion.

OAuth token resolution order:

1. `~/.pi/agent/auth.json` → `anthropic.access`
2. macOS Keychain: `security find-generic-password -s "Claude Code-credentials" -w` → `claudeAiOauth.accessToken` (Claude Code credentials)

## PR lookup

Branch → PR mapping via `gh pr view --json number,url --jq '"\(.number)\t\(.url)"'`, spawned fire-and-forget from the render path. Cached per-branch for 60s, including misses (so non-PR branches don't refetch every render window). The PR number is rendered as an OSC 8 hyperlink (`hyperlink()` from `@earendil-works/pi-tui`).

## Performance notes

The footer render path is kept synchronous:

- Cost/lines totals require an O(session) walk of `ctx.sessionManager.getBranch()`; they're cached and recomputed only when the branch entry count changes or every 5s.
- Usage limits and PR data are both cache-reads on render, with async background refresh.
- Re-renders are requested on branch change (`footerData.onBranchChange`), PR refresh completion, usage refresh completion, and `thinking_level_select`.

## Configuration

Optional global config: `~/.pi/agent/configs/statusline.json`. Changes take effect on the next session or after `/reload`.

```json
{
  "hiddenStatuses": ["mcp"]
}
```

`hiddenStatuses` contains stable extension status keys—the first argument passed to `ctx.ui.setStatus(key, text)`. Only matching extension-provided segments are omitted; built-in model, cost, context, usage, and branch segments are unaffected. The default is `[]`, which preserves all extension statuses. Missing or invalid config falls back to the default and invalid config emits a warning.

For example, `pi-mcp-adapter` publishes its server-count segment under the `mcp` key, while this repository's subagent fleet uses `subagents`.

Environment variables read:

| Variable    | Use                                                      |
| ----------- | -------------------------------------------------------- |
| `TMUX`      | Detect tmux; parsed as fallback for session name         |
| `TMUX_PANE` | Pane id for status files and `claude-notify`             |
| `HOME`      | Locates `~/.cache/pi-status` and `~/.pi/agent/auth.json` |
| `TMPDIR`    | Usage cache directory (default `/tmp`)                   |

Hardcoded constants you may want to tweak in `index.ts`:

| Constant          | Default      | Meaning                                            |
| ----------------- | ------------ | -------------------------------------------------- |
| `USAGE_CACHE_TTL` | `120` (s)    | How fresh the usage cache must be before a refetch |
| `PR_CACHE_TTL`    | `60` (s)     | Branch→PR cache lifetime                           |
| Totals recompute  | `5000` (ms)  | Max age of cached cost/lines totals                |
| Context bar width | `5..40` cols | Clamp for the stretch-to-fill context bar          |

## Dependencies

- `@nicknisi/pi-shared` (workspace) — `columns()` two-column layout helper (left-truncates to ~45% when the line overflows).
- `@earendil-works/pi-coding-agent` (peer) — `ExtensionAPI`, `Theme`.
- `@earendil-works/pi-ai` (peer) — `AssistantMessage` type for usage/cost.
- `@earendil-works/pi-tui` (peer) — `hyperlink()`, `visibleWidth()` for ANSI-aware width math.
- Runtime external commands: `tmux`, `gh`, `curl`, `security` (macOS), `claude-notify`.

## Caveats

- **pi internals**: relies on `ctx.ui.setFooter`, `footerData.getGitBranch()` / `onBranchChange()`, `ctx.sessionManager.getBranch()`, `ctx.getContextUsage()`, `pi.getThinkingLevel()`, and toolResult `details.linesAdded/linesRemoved` (an edit-tool implementation detail). Any of these can change across pi versions.
- **Theme colors**: assumes theme color names `accent`, `success`, `warning`, `error`, `dim`.
- **Nerd fonts**: icons are private-use-area nerd font codepoints; renders as boxes without a patched font.
- **macOS-only paths**: the Keychain fallback for OAuth tokens and the `security` binary are macOS-specific. `claude-notify` is a personal script expected on `PATH`.
- **Anthropic-only usage segment**: the OAuth usage API is called with a bearer token from pi/Claude Code auth; non-Anthropic models skip the segment entirely.
- **`require` in ESM**: `removeStatus()` uses `require("node:fs")` inside a `"type": "module"` package — works under pi's loader but would fail under plain Node ESM.
- Duplicate `session_start` handlers (one for the footer, two for tmux status) — harmless but worth knowing when editing.
