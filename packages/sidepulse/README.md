# @nicknisi/pi-sidepulse

Makes [SidePulse](https://sidepulse.io) LEDs follow pi sessions the same way the SidePulse installer's built-in hooks follow Claude Code, Codex, Cursor, Junie and Grok. SidePulse ships no pi hook, so without this pi runs never show up on the device or in the SidePulse menu bar.

## What it adds

No commands, tools, widgets or entry types. It listens to pi lifecycle events and reports each pi session to the SidePulse background service with `sidepulse report`:

| pi event           | SidePulse state                                                                            | LEDs  |
| ------------------ | ------------------------------------------------------------------------------------------ | ----- |
| `session_start`    | `idle`                                                                                     | —     |
| `agent_start`      | `working`                                                                                  | cyan  |
| `ui_prompt_start`  | `blocked` (`--kind permission` for confirm, `question` otherwise; prompt title as `--msg`) | amber |
| `ui_prompt_end`    | back to the state before the prompt                                                        |       |
| `agent_settled`    | `done`, or `idle` when the run was aborted                                                 | green |
| `session_shutdown` | `clear` (removes the session)                                                              |       |

Each pi session reports under its own scope, `pi-<sessionId>`, with app `pi` and the session name (or the cwd's folder name) as its title, so it gets its own row in the SidePulse menu bar and `sidepulse status`. `ui_prompt_*` covers every `ctx.ui` prompt, so any extension dialog (for example `ask_user_question` or a permission confirm) lights the device amber.

## Requirements

- The SidePulse software installed with `curl -fsSL https://sidepulse.io/setup.sh | sh`, which puts the CLI at `~/.local/bin/sidepulse` and runs the background service.
- pi ≥ 1.1 (`agent_settled` with `aborted`, `ui_prompt_*` events).

## Configuration

None. The CLI path is fixed to `~/.local/bin/sidepulse`, the installer's default.

## Caveats

- **Best-effort.** Reports are spawned in order and never block pi; on shutdown pi waits at most 0.5s for the final `clear`. If the CLI is missing or the background service is down, they fail silently.
- **UI sessions only.** Runs without a UI (`pi -p`, JSON mode) don't report, so one-shot scripts don't leave stale sessions behind. Interactive (TUI) and RPC sessions both report, since RPC hosts can show `ctx.ui` prompts too, so SDK/RPC embeddings get their own SidePulse rows.
- **Killed sessions.** If pi is killed instead of quitting cleanly (for example, the terminal is closed), `clear` may not be sent. The SidePulse service expires old sessions on its own.
- Each report starts a short-lived `sidepulse` process (about 0.1s on an M-series Mac), a handful per prompt.
- Depends on the SidePulse `report` CLI interface (`--scope`, `--state`, `--app`, `--title`, `--kind`, `--msg`), documented in SidePulse's [program status protocol](https://github.com/inteliwear/sidepulse/blob/main/docs/protocol/program-status.md).

## Install

```bash
pi install /Users/nicknisi/Developer/pi-extensions/packages/sidepulse
```
