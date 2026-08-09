# @nicknisi/pi-turn-timer

Shows how long a complete run took — from the moment you send a message until the agent settles and is awaiting your next message — as a dim one-line row rendered below the response, similar to Claude Code's per-turn elapsed timer. It exists because pi has no built-in per-run timing display. A run that spans multiple LLM responses and tool-call rounds still produces a single timer row.

## What it adds

- **UI:** a custom transcript entry renderer that draws a dim text row of the form `· 12.3s` (or `· 1m 23s` for ≥ 60s) after each completed turn.
- **Events hooked:** `agent_start` (records the start timestamp), `agent_settled` (computes elapsed time and appends the entry). `agent_settled` fires only once the agent is idle and won't continue automatically (no retry/compaction/follow-up remaining), so the timer covers the whole run.
- **Custom entry type:** `turn-duration`, with data shape `{ seconds: number }`.

No slash commands, tools, keybindings, or overlays. No configuration.

## Behavior details

- The entry is a custom transcript entry that does **not** participate in LLM context, so it never pollutes the conversation.
- `/copy` reads only assistant message text, so it never picks up the timer rows.
- Timing starts from `Date.now()` on `agent_start`. Elapsed time is computed with `Date.now()` at `agent_settled`.
- If `agent_settled` fires without a prior `agent_start` (e.g. extension loaded mid-run), the event is ignored.
- Duration formatting: `< 60s` → `Ns.s` (one decimal, e.g. `0.8s`); `≥ 60s` → `Mm Ss` (e.g. `1m 23s`).

## Configuration

None. No config files, no options, no environment variables.

## Dependencies

- `@earendil-works/pi-coding-agent` (peer) — `ExtensionAPI`: `registerEntryRenderer`, `on`, `appendEntry`.
- `@earendil-works/pi-tui` (peer) — `Text` component used to render the row.

No npm runtime dependencies, no workspace deps.

## Caveats

- Depends on pi extension internals: `registerEntryRenderer`, `appendEntry`, and the `agent_start` / `agent_settled` event names. A pi release that renames these APIs or events breaks the extension.
- Relies on the theme's `"dim"` foreground color existing; unusual themes could render the row differently.
- Uses wall-clock time (`Date.now()`), so the measurement includes any time the session sat idle mid-turn (e.g. waiting on an interactive tool prompt or permission prompt).
- No platform-specific behavior; works anywhere pi runs.

## Install

```bash
pi install /Users/nicknisi/Developer/pi-extensions/packages/turn-timer
```
