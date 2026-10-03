# @nicknisi/pi-heads-up

A side agent that reads the session during long tasks and shows at most one short note above the editor: something with consequences you would plausibly miss. Its default answer is nothing.

Ported from the Claude Code `heads-up` mod, itself a fork of Claude Code's built-in "You should know" mod. The prompt, reply format, parser, thresholds, and actions are carried over. The parts that depend on Claude Code internals are rebuilt on pi APIs (see [Differences from the Claude Code mod](#differences-from-the-claude-code-mod)).

## What it adds

| Surface       | Name                                | Notes                                                             |
| ------------- | ----------------------------------- | ----------------------------------------------------------------- |
| Widget        | `heads-up` (above editor)           | The collapsed note: `<tag> · <learn>` plus the shortcut hint      |
| Shortcut      | `alt+h` (configurable)              | Opens the note's action panel in place of the editor              |
| Slash command | `/heads-up [on\|off\|check\|show]`  | Status, toggle, force a check, open the panel                     |
| Config file   | `~/.pi/agent/configs/heads-up.json` | Thresholds, model, shortcut, digest budget                        |
| State file    | `~/.pi/agent/heads-up/store.json`   | Known topics, recent offers, on/off, feedback events (local only) |

TUI only. In print, JSON, and RPC modes the extension does nothing.

## How it works

### When a check runs

- `before_agent_start` starts tracking a run: elapsed time and tool count reset.
- `tool_execution_start` counts tool calls.
- A run counts as **long** at `minTools` tool calls (default 8) or `minSeconds` (default 120).
- `agent_end` for a run that ended with an answer (not aborted, not an error) requests a check if the run was long.
- A 10 s timer, started on `session_start`, runs a requested check. It also runs one mid-run once the running run counts as long.
- Gates: one check in flight, `cooldownSeconds` between checks (default 300), no note already showing, not turned off.

The check runs from the timer, never inside an event handler, so a slow side request never holds up the agent loop.

### The check

The side agent gets a **digest** of the context the main agent sees (`sessionManager.buildContextEntries()`, so compaction is applied):

- user and assistant text in full
- tool calls as `Tool call <name>: <args>`, args capped at 300 chars
- tool results capped at 400 chars, marked `[error]` when they failed
- `!` bash commands (not `!!`) with capped output
- compaction and branch summaries

The most recent sections are kept within `maxDigestChars` (default 120,000, about 30k tokens); older ones are dropped with an `[Earlier conversation omitted]` marker.

The digest goes to the configured `model` (default: the session model) as one tool-less request with no prompt caching. Topics offered recently and topics you marked known are listed in the prompt so the side agent skips them.

### Reply format

```
learn: none
```

or

```
learn: <~20 words, ends with a period>
tag: Heads up | You should know
explain:
**<title stating the takeaway>**
<≤120 words>
```

- **Heads up**: about this session's work, such as a decision the agent made in passing or a result that may be wrong.
- **You should know**: how a system or concept works, when understanding it matters for the work.

The parser tolerates bold labels, bullets, quotes, smart quotes, and a `#` heading title. Anything incomplete is no note, so a half note never shows.

## Usage

A note appears above the editor as a bordered card in the tag's color: amber `⚑ Heads up` for this session's work, accent `✦ You should know` for background knowledge.

```
╭─ ⚑ Heads up ─────────────────────────────────────────────── alt+h to open ─╮
│ The agent skipped the migration test because it needs a live database.    │
╰─ learn more · make a page · knew this · dismiss ───────────────────────────╯
```

Press `alt+h` (or run `/heads-up show`) to open the panel. It takes the editor's place in the same frame, with the note's age in the top border and key chips below the text:

```
╭─ ⚑ Heads up ──────────────────────────────────────────────────── just now ─╮
│ The agent skipped the migration test because it needs a live database.    │
├────────────────────────────────────────────────────────────────────────────┤
│  1  learn more    2  make a page    3  knew this    0  dismiss    esc  back │
╰────────────────────────────────────────────────────────────────────────────╯
```

| Key   | Collapsed view                                                | Expanded view                                             |
| ----- | ------------------------------------------------------------- | --------------------------------------------------------- |
| `1`   | Learn more: expand to the title and explainer                 |                                                           |
| `2`   | Make a page: ask the main agent to write an artifact about it | same                                                      |
| `s`   |                                                               | Simpler: rewrite in plain words (≤100 words)              |
| `l`   |                                                               | Shorter: the single key point (≤45 words)                 |
| `m`   |                                                               | More detail: real keys, files, edge case (≤160 words)     |
| `c`   |                                                               | Ask in chat: send `Explain this to me: …` as your message |
| `3`   | Knew this: never suggest this topic again                     | same                                                      |
| `0`   | Dismiss                                                       | same                                                      |
| `esc` | Back to the editor; the note stays                            | same (cancels a rewrite in progress)                      |

Rewrites are side requests too, over a fresh digest. The panel remembers the expanded view and the latest rewrite until the note is cleared.

"Make a page" and "Ask in chat" send a user message to the main agent, queued as a follow-up when the agent is busy. "Make a page" asks for an artifact, which works best with [`@nicknisi/pi-artifacts`](../artifacts/).

Submitting a prompt while a note is showing clears the note and logs it as `ignored_submit`.

### Command

```
/heads-up          status: on/off, thresholds, model, known count, event tally
/heads-up off      stop checking and clear any note (persists across sessions)
/heads-up on       resume
/heads-up check    run a check now (ignores the run-length trigger and cooldown)
/heads-up show     open the panel for the current note
```

## Configuration

`~/.pi/agent/configs/heads-up.json` (all fields optional; read at startup, `/reload` to apply changes):

```json
{
  "minTools": 8,
  "minSeconds": 120,
  "cooldownSeconds": 300,
  "model": "anthropic/claude-haiku-4-5",
  "shortcut": "alt+h",
  "maxDigestChars": 120000
}
```

| Field             | Default       | Meaning                                                     |
| ----------------- | ------------- | ----------------------------------------------------------- |
| `minTools`        | `8`           | A run with at least this many tool calls counts as long     |
| `minSeconds`      | `120`         | A run lasting at least this long counts as long             |
| `cooldownSeconds` | `300`         | Minimum gap between two checks                              |
| `model`           | session model | Side-agent model as `provider/model-id`                     |
| `shortcut`        | `alt+h`       | Key that opens the panel (pi key syntax)                    |
| `maxDigestChars`  | `120000`      | Transcript digest budget; the most recent sections are kept |

Invalid values fall back to the defaults. An unknown `model` falls back to the session model with a warning.

## State

`~/.pi/agent/heads-up/store.json` is shared by every pi session on the machine:

| Key        | Holds                                            |
| ---------- | ------------------------------------------------ |
| `known`    | Topics marked understood (at most 50)            |
| `offered`  | Last 5 suggestions, so the next check skips them |
| `disabled` | Set by `/heads-up off`                           |
| `events`   | `{ ts, kind, learn }`, last 500                  |

Event kinds: `proposed`, `explained`, `page`, `chat`, `known`, `dismissed`, `ignored_submit`. Use them to tune: a high dismiss or ignore rate means the bar is too low. `/heads-up` shows the tally.

The note itself lives in memory and does not survive a restart.

## Differences from the Claude Code mod

- **Digest instead of a fork.** Claude Code's `$.model.fork` resends the real transcript so the prompt cache serves the prefix. Pi has no fork API, and replaying the main request byte-for-byte (tools, system prompt, loadout rewrites) to hit the cache is fragile. A capped text digest to any model is smaller and works with every provider. The trade-off: the side agent sees shortened tool output.
- **Shortcut instead of band focus.** Pi widgets cannot take focus, so `alt+h` opens the panel in place of the editor. In Claude Code the band takes focus with ctrl+x tab or a click.
- **`input` instead of `prompt.submit`** for clearing an unanswered note. Notes cleared by the extension's own messages are not logged as ignored.
- **Tool counting** counts every `tool_execution_start`. Pi subagents run in separate processes, so their calls never reach this count.
- **`/heads-up check` and `/heads-up show`** are new.

## Caveats

- Each check is one full-digest request without caching, up to about 30k input tokens by default. With a large session model, set `model` to something cheaper or lower `maxDigestChars`.
- The thresholds are guesses, carried over from the Claude Code mod. The built-in mod's firing rule is compiled in and unreadable.
- No idle-time checks. A check only follows agent activity.
- A background check that fails warns once, then stays quiet until a check succeeds.
- The built-in's "Not relevant" and "Hard to read" feedback buttons are not ported. Dismiss covers both.
