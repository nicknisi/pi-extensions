# @nicknisi/pi-checkpoint

Durable self-compaction for long-running autonomous Pi sessions. Adds a single
`self_compact` tool that lets the agent checkpoint itself: it saves the exact
next action as a verbatim note, compacts the conversation once the current tool
batch is idle, then resumes from the note automatically — without another human
prompt. Threshold controls, an editable summary instruction, and a context
widget make the behavior observable and tunable.

Checkpoint retains the `self_compact` tool, `/self-compact-*` commands, and
`self-compact` resource and event names; the package name does not change them.

## Requirements

- **Pi >= 0.87.0.** The extension uses actionable turn boundaries, deferred
  settled-handler continuations, and canonical session context from this version.
  Older runtimes are unsupported.
- **No other extensions.** This package uses only the public extension API and
  has no dependency on any other extension or on `@nicknisi/pi-shared`.

## Install

```bash
pi install /path/to/pi-extensions/packages/checkpoint
```

Or load a single source file directly for one session:

```bash
pi -e /abs/path/packages/checkpoint/extensions/self-compact/self-compact.ts
```

## What it adds

- **Tool:** `self_compact({ note_to_self })`. Call it as your only action when
  context is getting large. The note is preserved verbatim and re-delivered
  after compaction.
- **Commands:** `/self-compact-info` (thresholds, usage, handoff state — never
  calls the model) and `/self-compact-now` (asks the agent to checkpoint now;
  retries a pending note verbatim).
- **Context display:** when `@nicknisi/pi-statusline` is loaded, Checkpoint
  colors its existing context bar and hides the separate widget. Without that
  extension, a 20-cell context widget remains above the editor (legend below).
  No other extension is required.
- **Flags:** `--compact-soft-at`, `--compact-at`, `--compact-buffer`,
  `--compact-prompt`.

## Flags and thresholds

| Flag                | Default | Meaning                                                                     |
| ------------------- | ------- | --------------------------------------------------------------------------- |
| `--compact-soft-at` | `225k`  | Advisory heads-up threshold: emits soft guidance to the model.              |
| `--compact-at`      | `250k`  | Warning threshold: emits stern guidance to self-compact.                    |
| `--compact-buffer`  | `20k`   | Extra tokens past `--compact-at` before ordinary tools are hard-paused.     |
| `--compact-prompt`  | (unset) | Literal summary system instruction that replaces the editable default file. |

**Value parsing.** A value is a whole token count (`250000`), a `k`/`m`
shorthand (`250k`, `0.5m`), or a window percentage (`70%`). Fractions are
allowed only when a suffix resolves to a whole token count (`1.5k` = 1500). No
expressions, signs, exponents, infinities, or trailing junk. `--compact-buffer`
may be `0`; the other thresholds must be greater than zero. A blank threshold or
a blank `--compact-prompt` is invalid.

**Resolution and ordering.** Thresholds resolve against the model's full context
window `W`. The hard cutoff is `hard = min(compact-at + buffer, floor(0.9 * W))`,
and the configuration must satisfy `0 < soft < warning <= hard <= floor(0.9 * W)`.
Percentages round half up.

**Invalid / small-model guidance.** If the thresholds cannot fit the model
window (e.g. the `225k`/`250k` token defaults on a 200k-token model), the
configuration fails closed: ordinary tool calls are blocked with an actionable
error, and `/self-compact-info` shows the reason. Use window-independent
percentages instead, e.g. `--compact-soft-at 20% --compact-at 50% --compact-buffer 10%`.
Thresholds are re-resolved when you switch models.

## Launch variants

Token thresholds (the defaults) require a model window of at least ~300k tokens:

```bash
# Defaults (225k / 250k / 20k) — needs a >=300k-token window.
pi -e "$PACKAGE/extensions/self-compact/self-compact.ts"

# Explicit token thresholds.
pi -e "$PACKAGE/extensions/self-compact/self-compact.ts" \
  --compact-soft-at 100k --compact-at 200k --compact-buffer 50k

# Window-independent percentages with a literal summary override.
pi -e "$PACKAGE/extensions/self-compact/self-compact.ts" \
  --compact-soft-at 20% --compact-at 50% --compact-buffer 0 \
  --compact-prompt "Summarize the current goal, completed work, exact paths, test results, and next action. Do not invent completed work."
```

## Editable prompts

Three templates live under `.pi/self-compact/` in the package and are read per
use (edit and reuse without a rebuild):

| File                                  | Purpose                                                  |
| ------------------------------------- | -------------------------------------------------------- |
| `USER_PROMPT_COMPACTION_MESSAGE.md`   | Default summary system instruction for every compaction. |
| `USER_PROMPT_SOFT_SELF_COMPACT.md`    | Soft heads-up guidance at `--compact-soft-at`.           |
| `USER_PROMPT_WARNING_SELF_COMPACT.md` | Stern warning guidance at `--compact-at`.                |

**Precedence.** A literal `--compact-prompt` always wins over
`USER_PROMPT_COMPACTION_MESSAGE.md`; the literal is never treated as a filename.
The summary instruction is independent of the saved handoff note, which is
delivered separately as a continuation.

**Interpolation vocabulary** (soft/warning templates): `{{tokens}}`,
`{{percent}}`, `{{context_window}}`, `{{soft_tokens}}`, `{{warning_tokens}}`,
`{{hard_tokens}}`, `{{hard_percent}}`. Unknown placeholders are left intact.

## Context bar legend

With `@nicknisi/pi-statusline`, the existing footer meter keeps its size, fill,
labels, and **remaining-context** meaning. Checkpoint supplies its color:
green below soft, blue/accent at soft, amber at warning, red at hard or on a
failed handoff, and dim while usage is unknown. No threshold ticks or additional
footer row are added. Theme colors may differ from these descriptions.

The optional integration uses Pi's event bus and works in either load order.
If the statusline is removed, the standalone widget returns automatically.

When running without the statusline, the widget renders 20 cells inside brackets (each cell = 5% of the window),
followed by the used percentage. With explicit 20%/50%/10% thresholds,
40% usage and half the used context cached:

```
[###~====-!-|--------] 40%
```

- `#` cached (prompt-cache) tokens, `=` remaining used tokens, `-` free.
- Threshold markers replace whichever cell they land on, with a deterministic
  collision priority: hard `|` > warning `!` > soft `~`.
- Right after a compaction, usage is momentarily unknown: the fills are blank,
  the markers and frame remain, and the label reads `?%` (never a fabricated
  `0%`).

## Note validation

`note_to_self` must be a non-blank string of at most 24000 characters. It is
saved verbatim — never trimmed or reformatted — and re-delivered exactly after
compaction.

## Lifecycle and recovery

- **Fail-closed.** A summary or prompt error cancels the compaction and keeps
  the note and lock intact; it never silently falls back to Pi's default
  compactor. The handoff stays `failed` and locked until you retry.
- **Explicit retry.** `/self-compact-now` (or the agent calling `self_compact`
  again with the same note) re-arms the same cycle with the unchanged note.
  There is no automatic retry scheduler.
- **Manual `/compact`.** A successful native `/compact` discharges a pending
  or failed handoff and delivers the continuation once idle. Pi's automatic
  compaction can discharge a pending handoff but does not retry a failed one.
  The command is not reimplemented.
- **Reload/resume.** Handoff state lives in branch-local custom entries. A
  pending/failed compaction stays recoverable; an already answered continuation
  is not replayed. If compaction landed but the note was not sent, or the note
  was journaled but never answered successfully, reload resumes it automatically
  without compacting again. Branch navigation isolates recovery.
- **Early requests.** A new checkpoint is rejected before saving or locking if
  Pi's retained recent context leaves nothing to summarize. The preflight uses
  projected context, including context edits and model-specific retention settings.
- **Current guidance.** The model receives fresh threshold guidance before each
  request rather than accumulated, stale notices. Humans see each crossing once.
  Warning/hard crossings during tool work can request one response using Pi's
  `turn_end` boundary; a finished answer is not restarted merely for a warning.
  Busy `/self-compact-now` requests steer after the current tool batch, without
  interrupting a running tool. Actual compaction still waits until idle.

## Durability limitations

- **`--no-session`.** With no session file there is nothing durable to
  reconstruct on restart; a checkpoint only survives within the live process.
- **Arbitrary-crash exactly-once is NOT promised.** Replay prevention covers
  ordinary reload/resume via journaled continuation messages and later successful
  assistant responses. A crash at exactly the
  wrong instant (e.g. between an external side effect and the delivery marker)
  can, in principle, repeat a side effect. Design resumable notes accordingly.

## Run modes

Works in interactive TUI, print mode (`pi -p`), and JSON mode
(`pi --mode json`). In single-shot print/JSON modes the process stays alive
until the compaction and continuation turn finish, so `result` side effects land
before exit.

## Development

All checks run from the repository root.

```bash
pnpm --filter @nicknisi/pi-checkpoint build
pnpm exec vitest run packages/checkpoint packages/statusline
pnpm --filter @nicknisi/pi-checkpoint typecheck
pnpm exec oxlint packages/checkpoint packages/statusline
pnpm exec oxfmt --check packages/checkpoint packages/statusline
```

The suite covers lifecycle recovery, thresholds, prompts, packaging, and statusline
integration. Pi session and CLI tests use an offline scripted provider, so no
model credentials or paid API calls are required. The helpers under `verify/`
are fixtures used by those tests.

SDK hosts using in-memory settings can supply the extension factory's optional
second argument, `(ctx) => settingsManager.getCompactionKeepRecentTokens(ctx.model)`,
so eligibility uses those same settings. Normal Pi loading reads its global and
trusted project settings; the extension never modifies them.

## Dependencies

- **Peer:** `@earendil-works/pi-coding-agent` (`>=0.87.0`) and `@earendil-works/pi-ai`
  (`>=0.87.0`). Uses only the public extension API.
- **Runtime:** `typebox` (tool schema). No workspace or sibling-extension deps.
