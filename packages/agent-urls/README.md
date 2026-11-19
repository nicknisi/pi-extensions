# @nicknisi/pi-agent-urls

`agent://` URL tools for reading subagent runs persisted by the first-party shared runtime (`@nicknisi/pi-shared`). The extension enumerates run records from `~/.pi/agent/subagent-runs/<namespace>/<runId>.json` — one JSON record per run, written by any extension on the shared in-process runtime (e.g. [subagents](../subagents)' `dispatch`, workflows, llm-council) — assigns each record a stable `agent://<namespace>/<runId>` URI, and exposes both a slash command and two LLM tools for listing and reading them. It exists so that a parent agent (or the human at the prompt) can pull a run's status, usage, output, or error back into context after the run has finished, using a short URI instead of a long filesystem path.

It no longer reads anything from nicobailon/pi-subagents (session JSONLs, tmpdir status dirs, artifact dirs, chain dirs) — that discovery is gone. Because records carry bounded output rather than transcripts, the old `history://` scheme and transcript rendering are dropped; there is no session file to render.

## Install

```bash
pi install npm:@nicknisi/pi-agent-urls
```

## What it adds

- Slash command: `/agent` (with `list`/`ls` and `read`/`show`/`cat` subcommands)
- Tool: `list_agent_runs` — list recent persisted subagent runs and their `agent://` URLs
- Tool: `read_agent_url` — read `agent://` URLs (run summaries, outputs, errors, raw records)
- Custom message type: `agent-url` (results of `/agent` commands are posted into the conversation as `display: true` custom messages with `details.kind = "agent-url-command"`)
- Argument completion for `/agent`: completes `list`/`read`, then (after `read`/`show`/`cat`) `agent://<namespace>/<runId>` for up to 20 of the most recent runs matching what you've typed. Completions list filenames only (no record parsing).
- Event hook: `session_start` — declares the two tools directly (`setActiveTools`) when pi's `tool_search` is not active (see [Tool exposure](#tool-exposure))

No keybindings, widgets, or overlays.

## URI scheme

```text
agent://<namespace>/<runId>             run summary (status, timing, usage, file path)
agent://<namespace>/<runId>/<leaf>      specific leaf of the record
agent://<runId>                         shorthand: resolves across all namespaces
```

`<runId>` may be abbreviated to any unique prefix; ambiguous or unknown prefixes throw. `<leaf>` is one of:

- `summary` (default) — formatted record summary
- `output` / `result` — the run's recorded output text
- `error` — the run's recorded error text
- `raw` / `json` — the raw record JSON as written to disk

## Usage

Slash command:

```text
/agent list
/agent list workflows
/agent read agent://subagents/7c6ef257
/agent read agent://subagents/7c6ef257/output
```

`/agent read` without a URI, or an unknown subcommand, shows a usage warning via `ctx.ui.notify`.

Tool usage (as called by the LLM):

```json
{ "tool": "list_agent_runs", "params": { "query": "subagents", "limit": 10 } }
{ "tool": "read_agent_url", "params": { "uri": "agent://subagents/7c6ef257/output", "maxLines": 1000 } }
```

`list_agent_runs` also returns the raw run records in `details.runs` for programmatic consumers; `read_agent_url` returns the rendered text with `details.uri` echoing the request.

## Run discovery

Runs are discovered on every invocation by scanning `<agentDir>/subagent-runs/<namespace>/*.json` (`<agentDir>` is pi's `getAgentDir()`, default `~/.pi/agent`) (or `$PI_SUBAGENTS_DIR/runs/<namespace>/*.json`, see below). Each file is a JSON `RunRecord`:

```json
{
  "runId": "7c6ef257-…",
  "namespace": "subagents",
  "agent": "geography",
  "promptPreview": "Answer briefly: …",
  "status": "completed",
  "startedAt": 1786203685145,
  "endedAt": 1786203686847,
  "usage": { "inputTokens": 2909, "outputTokens": 63, "cost": 0.0032 },
  "output": "Tokyo is the capital of Japan."
}
```

Unreadable files, invalid JSON, and records without a string `runId` are skipped; a record missing `namespace` inherits its directory name. Sort order is `endedAt ?? startedAt ?? file mtime`, newest first. Usage fields accept both `input`/`output` and `inputTokens`/`outputTokens` spellings. Scan cap: the 2500 most recently modified record files (by file mtime) are parsed, so the newest runs are never dropped. Records still `queued`/`running` whose `hostPid` process no longer exists (a host that died mid-run) are reported with status `stale`.

## Configuration

No config files are read. No per-run options.

Environment variables:

- `PI_CODING_AGENT_DIR` — pi agent directory, resolved via pi's `getAgentDir()` on every call (same normalization as the extensions that write runs). Defaults to `~/.pi/agent`. This determines where `subagent-runs/` is scanned.
- `PI_SUBAGENTS_DIR` — when set, runs are read from `$PI_SUBAGENTS_DIR/runs/` instead, matching where the shared runtime writes them. Read on every call.

Constants (hardcoded in `index.ts`):

- `MAX_SCAN_FILES = 2500` — record cap per scan (newest files first)
- `DEFAULT_LIMIT = 20` — runs listed by default (tool clamps `limit` to 1–100)
- `DEFAULT_MAX_LINES = 500` — rendered line cap for reads (tool clamps `maxLines` to 20–5000)

## Dependencies

- `@earendil-works/pi-coding-agent` (peer, `*`) — `getAgentDir`, `ExtensionAPI` (`registerTool`, `registerCommand`, `sendMessage`, `on`, `getActiveTools`, `setActiveTools`) and `ctx.ui.notify`.
- `@nicknisi/pi-shared` (`workspace:*`) — `declareUnlessSearchable` (deferred tool fallback), `subagentsDir` (`PI_SUBAGENTS_DIR` resolution), and `pidAlive` (stale-run detection).
- Node builtins: `fs`, `path`. No other runtime dependencies.

## Tool exposure

`list_agent_runs` and `read_agent_url` register with `exposure: "deferred"` (pi ≥0.99), so they stay out of the system prompt when pi's built-in `tool_search` is active (`"defaultTools": ["+tool_search"]`): the model finds them on demand. Without `tool_search` the extension declares them directly at session start, as before. Older pi ignores the field. `list_agent_runs` declares an `outputSchema`, so codemode scripts get `{ runs: [{ url, runId, namespace, agent?, status?, durationMs?, prompt? }] }` instead of text. Tools also carry `annotations` (read-only/destructive/open-world hints) for permission extensions.

## Caveats

- Depends on the shared runtime's on-disk record layout (`<agentDir>/subagent-runs/<namespace>/<runId>.json` and the `RunRecord` shape), which is not a stable API; a schema change silently reduces discovery to partial or empty results (all parse failures are swallowed).
- Records carry bounded output, not transcripts — there is no equivalent of the old `history://` rendered-session reads.
- Discovery is synchronous filesystem I/O on every command/tool call; very large `subagent-runs/` trees are mitigated only by the record cap.
- Truncated reads append a `[truncated: N more line(s)]` marker.
- Results of `/agent` are injected as custom `agent-url` messages with `display: true`; themes or UIs that don't handle unknown custom message types may render them differently. These messages also enter the LLM context: an `/agent read` can add up to 500 lines (`DEFAULT_MAX_LINES`) to the conversation.
