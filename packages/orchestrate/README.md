# @nicknisi/pi-orchestrate

Claude Code-style `/goal` and `/loop` for pi. `/goal <condition>` makes the session keep working across turns until a small sidecar model (no tools, transcript-only) judges the condition met, then clears itself. `/loop [interval] <prompt>` re-runs a prompt on a timer or self-paced after every `agent_end`. One goal and one loop per session; state persists to disk keyed to the owning session file so it survives `--resume` without leaking into other sessions sharing the same cwd.

## What it adds

- Slash commands: `/goal`, `/loop`
- Status line entry (`pi-goal`): shows active goal (duration, turns) or loop (pace, runs)
- Events hooked: `session_start`, `agent_end`, `session_compact`, `turn_start`
- Files read/written: `<cwd>/.pi-goal/state.json`, `<cwd>/.pi-loop.md`
- No tools, no widgets, no keybindings, no custom message/entry types

## Commands

### `/goal`

```
/goal <condition>    set a completion condition; pi keeps working until met
/goal                show status (condition, duration, turns, last evaluator reason)
/goal clear          remove the active goal
```

Clear aliases: `clear`, `stop`, `off`, `reset`, `none`, `cancel`. Tab completion is provided for `clear` and `stop`. Stop means stop: clearing also stops a running `/loop` (a runaway "goal" is usually a loop, which `/goal` subcommands otherwise can't see) and aborts the in-flight turn so the stop is immediate.

Setting a goal immediately sends the condition as a user message (`deliverAs: "followUp"` when idle, `"steer"` mid-turn). After each `agent_end`, the evaluator reads the transcript tail (last ~20000 chars, text content only) and returns `YES`/`NO` plus a one-sentence reason. On `NO`, the reason is fed back as guidance for the next turn. On `YES`, the goal clears automatically. If the evaluator itself errors, the session keeps working toward the condition (the failure is treated as transient, not as a goal verdict).

Example:

```
/goal the test suite passes with no failures
```

### `/loop`

```
/loop [interval] <prompt>   start a loop
/loop                       show status
/loop stop                  stop the loop (cancel also works)
```

Two pacing modes:

- **Timer-paced**: leading interval token — `Nms`, `Ns`, `Nm`, `Nh` (e.g. `5m`, `30s`). Fires on a `setTimeout` regardless of session activity.
- **Self-paced**: no interval. The prompt is re-sent ~1.5s after each `agent_end` (delay avoids losing the message at the teardown boundary).

```
/loop 5m check if the deploy finished
/loop check if the deploy finished      # self-paced
/loop 5m                                # interval + default prompt
/loop                                   # no args → status, NOT a default loop
```

If the prompt is omitted (or only an interval is given), the prompt comes from `<cwd>/.pi-loop.md` if it exists, otherwise:

```
Run a maintenance check: review the repository state and address anything stale, broken, or left half-finished.
```

## Persistence

State is written to `<cwd>/.pi-goal/state.json`:

```json
{
  "owner": "/absolute/path/to/session-file.jsonl",
  "goal": { "condition": "...", "startedAt": 0, "turns": 0, "lastReason": "...", "lastEvalAt": 0 },
  "loop": { "prompt": "...", "intervalMs": 300000, "iterations": 0, "lastTickAt": 0 }
}
```

Semantics:

- `owner` is the session file path. Persisted state is re-adopted **only** by that exact session (i.e. via `--resume`). Any other session in the same cwd — different session, ephemeral session, or legacy state with no owner stamp — ignores it. This is deliberate: an earlier cwd-keyed version leaked goals into every concurrent session in the directory.
- Orphaned state whose owning session file no longer exists is pruned on load.
- Ephemeral sessions (no session file) never persist; goal/loop state is memory-only.
- The state file is deleted when both goal and loop are cleared.
- Persistence is advisory: all fs errors are swallowed and never block the loop.

Restoration happens on `session_start`; a timer-driven loop is re-armed. On `session_compact` (which ends without an `agent_end`), a goal continuation or self-paced loop tick is re-sent after 2s.

## The evaluator

Implemented as a throwaway `createAgentSession` with:

- the current session's model and model runtime (`ctx.model`, `ctx.modelRegistry.runtime`)
- `thinkingLevel: "minimal"`
- `tools: []` — judges only from surfaced conversation (Claude Code semantics)
- an empty `ResourceLoader` (no extensions, skills, prompts, themes, agents files) with a synthetic system prompt instructing `YES`/`NO` + one-sentence reason
- `SessionManager.inMemory` / `SettingsManager.inMemory` — nothing touches disk

Only one evaluator runs at a time (`evalInFlight` guard). Parse rule: first non-blank line must start with `yes` (case-insensitive) to count as met.

## Configuration

No settings file and no environment variables. Behavior is controlled entirely by:

- `/goal` and `/loop` arguments
- optional `<cwd>/.pi-loop.md` — default loop prompt
- `<cwd>/.pi-goal/state.json` — managed by the extension; do not hand-edit

## Dependencies

- `@earendil-works/pi-coding-agent` (peer, `*`): imports `createAgentSession`, `createExtensionRuntime`, `SessionManager`, `SettingsManager`, and the `ExtensionAPI` / `ExtensionContext` / `ResourceLoader` types. The evaluator sub-session is the heavy consumer of these APIs.
- No npm runtime deps, no workspace deps. Node builtins (`fs`, `path`) only.

## Caveats

- **Package name vs. content**: `package.json` describes this as "Multi-agent orchestration across pi sessions", but the current code implements goal/loop, not cross-session orchestration.
- **Pi internals**: `transcriptTail` reaches into `sessionManager.buildSessionContext()` (not a public Extension API) via a structural cast and degrades to `"(transcript unavailable)"` if missing. `evaluateGoal` reads `(ctx as any).model` and `(ctx as any).modelRegistry?.runtime` — undocumented context fields that could change across pi versions.
- **Event names**: `session_start`, `session_compact`, and `turn_start` are registered with `pi.on("..." as any)`, so they are not type-checked against pi's event map. `agent_end` is.
- **Stale contexts**: the extension caches the last `ExtensionContext` and probes `ctx.isIdle()` before reuse; timer callbacks silently no-op if the context has gone stale. Errors matching `stale|invalid|session replacement|assertActive` are treated as expected.
- **Evaluator cost**: one sub-session prompt per `agent_end` while a goal is active, using the session's current model. Cheap by design (no tools, minimal thinking) but not free — on long-running goals this adds a call per turn.
- **`ms` intervals**: `parseInterval` accepts `Nms` (e.g. `/loop 500ms ...`), which yields sub-second loops. Use deliberately.
- No platform-specific behavior (no tmux/ghostty/macOS dependencies); persistence is plain fs.

## Install

```
pi install /Users/nicknisi/Developer/pi-extensions/packages/orchestrate
```

Add `<cwd>/.pi-goal/` to your global gitignore if you don't want state files showing up in repo status.
