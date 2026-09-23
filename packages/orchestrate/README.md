# @nicknisi/pi-orchestrate

Evidence-aware `/goal` and recurring `/loop` for pi. `/goal <condition>` keeps working until a sidecar using the **current session's model** finds cited evidence of completion, or pauses when verification or continuation budgets fail. No Jev, separate provider, or additional credentials are needed. `/loop [interval] <prompt>` re-runs a prompt on a timer or self-paced after every `agent_end`. One goal and one loop per session; state persists to disk keyed to the owning session file so it survives `--resume` without leaking into other sessions sharing the same cwd.

## What it adds

- Slash commands: `/goal`, `/loop`
- Status line entry (`pi-goal`): shows active/paused goal (duration, runs/budget) or loop (pace, runs)
- Events hooked: `session_start`, `agent_end`, `session_compact`, `session_shutdown`, `turn_start`
- Files read/written: `<cwd>/.pi-goal/state.json`, `<cwd>/.pi-loop.md`
- No tools, no widgets, no keybindings, no custom message/entry types

## Commands

### `/goal`

```
/goal <condition>    set a completion condition; work until verified or paused
/goal                show status, last verdict reason, and evidence entry IDs
/goal resume         resume a paused goal with a fresh continuation budget
/goal clear          remove the active or paused goal
```

Clear aliases: `clear`, `stop`, `off`, `reset`, `none`, `cancel`. Tab completion is provided for `clear`, `stop`, and `resume`. Stop means stop: clearing also stops a running `/loop` (a runaway "goal" is usually a loop, which `/goal` subcommands otherwise can't see) and aborts the in-flight turn so the stop is immediate.

Setting a goal immediately sends the condition as a user message (`deliverAs: "followUp"` when idle, `"steer"` mid-turn). After each `agent_end`, a tool-free evaluator reads bounded evidence from the active session branch and returns a structured verdict:

- **`met`**: the goal clears only with valid citations to supplied evidence. For external state (files, tests, deployments), the evaluator must cite tool results or direct shell executions. For an answer-only goal, it may cite the actual assistant deliverable.
- **`not_met`**: the reason becomes guidance for the next run.
- **`unknown`**: missing, stale, truncated, or ambiguous evidence triggers one attempt to gather the missing checks. Two consecutive unknown verdicts pause the goal rather than guessing success.

Provider failures, malformed responses, invalid evidence citations, evaluator timeouts, or an aborted/failed agent run **pause immediately**. Pausing preserves the condition and reason, stops any concurrent `/loop`, and does not queue more work. `/goal resume` resets the budget and unknown counter; `/goal clear` discards the goal. A replacement goal cannot receive a stale evaluator result.

Automatic continuation is limited to **10 completed agent runs or 30 minutes**, whichever comes first. These are boundary checks at `agent_end` and compaction continuation, **not a hard timeout on the main agent or individual tools**. An agent run may contain many model/tool turns. Pauses survive `--resume`, and compaction cannot restart a paused goal.

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
  "goal": {
    "condition": "...",
    "startedAt": 0,
    "turns": 2,
    "lastReason": "The test output is missing.",
    "lastEvalAt": 0,
    "lastVerdict": "unknown",
    "evidence": [],
    "unknowns": 2,
    "pausedReason": "Unable to verify completion twice."
  },
  "loop": { "prompt": "...", "intervalMs": 300000, "iterations": 0, "lastTickAt": 0 }
}
```

Semantics:

- `owner` is the session file path. Persisted state is re-adopted **only** by that exact session (i.e. via `--resume`). Any other session in the same cwd — different session, ephemeral session, or legacy state with no owner stamp — ignores it. This is deliberate: an earlier cwd-keyed version leaked goals into every concurrent session in the directory.
- Orphaned state whose owning session file no longer exists is pruned on load.
- Ephemeral sessions (no session file) never persist; goal/loop state is memory-only.
- The state file is deleted when both goal and loop are cleared.
- Persistence is advisory: all fs errors are swallowed and never block the loop.

Restoration happens on `session_start`; a timer-driven loop is re-armed. The legacy `turns` field counts completed agent runs in the current budget window. Optional verification fields are absent in older state files, which remain supported. On `session_compact`, an active goal continuation (subject to its budget) or self-paced loop tick is re-sent after 2s. Pending goal continuations are ignored after goal replacement, pause, or session shutdown.

## The evaluator

Implemented as a throwaway `createAgentSession` with:

- the current session's model and model runtime (`ctx.model`, `ctx.modelRegistry.runtime`)
- `thinkingLevel: "minimal"`
- `tools: []` — judges evidence but cannot run commands or inspect files itself
- an empty `ResourceLoader` (no extensions, skills, prompts, themes, agents files) with a synthetic system prompt requiring JSON: `verdict`, `reason`, `basis` (`tool` or `answer`), and `evidence` (session entry IDs)
- `SessionManager.inMemory` / `SettingsManager.inMemory` — no evaluator transcript written to disk; automatic provider retries disabled
- a 60-second timeout on the evaluator prompt, with abort, unsubscribe, and disposal on completion/error/cancellation

Evidence comes from the public `sessionManager.getBranch()` API, not reconstructed compaction summaries. The approximately 20,000-character window retains up to 4,000 characters per entry (both ends of large outputs). It includes tool calls/arguments, tool names, result error flags, and direct shell command/exit-code/output metadata. Thinking, images, tool `details`, and shell executions excluded from model context are not sent. Truncated or omitted evidence may require a fresh check.

Code validates the verdict shape, citation existence, and citation roles for the declared basis. The evaluator is instructed to reject assistant assurances as proof of external state, distinguish requested commands from executed checks, and treat checks before later relevant edits as stale. **Semantic correctness and the choice of basis still depend on the model**: this is not independent proof that tests passed, and arbitrary natural-language goals are not translated into automatically executed commands. Use concrete goals and surface actual check results.

One evaluation per active goal runs at a time. Clear, replacement, session restart, and shutdown cancel outstanding evaluation; late results cannot mutate a newer goal. The last verdict/reason/evidence references are persisted while the goal exists; completion notifications include evidence IDs. This is not an append-only audit log.

## Configuration

No settings file and no environment variables. Behavior is controlled entirely by:

- `/goal` and `/loop` arguments (including `/goal resume` to explicitly renew a paused goal)
- built-in goal limits: 10 runs, 30 minutes between continuations, 2 consecutive unknown verdicts, and 60 seconds per evaluator prompt
- optional `<cwd>/.pi-loop.md` — default loop prompt
- `<cwd>/.pi-goal/state.json` — managed by the extension; do not hand-edit

## Dependencies

- `@earendil-works/pi-coding-agent` (peer, `*`): imports `createAgentSession`, `createExtensionRuntime`, `SessionManager`, `SettingsManager`, and the `ExtensionAPI` / `ExtensionContext` / `ResourceLoader` types. The evaluator sub-session is the heavy consumer of these APIs.
- No npm runtime deps, no workspace deps. Node builtins (`fs`, `path`) only.

## Caveats

- **Package name vs. content**: `package.json` describes this as "Multi-agent orchestration across pi sessions", but the current code implements goal/loop, not cross-session orchestration.
- **Pi internals**: evidence and model selection use public context APIs, but sharing the model registry's backing runtime still uses a structural cast because that property is private in pi 0.84. A pi upgrade could change it.
- **Evidence limitations**: the evaluator sees bounded text, not the filesystem or screenshots. Citation validation prevents invented IDs, not an incorrect interpretation of a real result. Unknown means unverified, never success.
- **Stale contexts**: the extension caches the last `ExtensionContext` and probes `ctx.isIdle()` before reuse; timer callbacks silently no-op if the context has gone stale. Errors matching `stale|invalid|session replacement|assertActive` are treated as expected.
- **Evaluator cost**: one sub-session prompt per `agent_end` while a goal is active, using the session's current model. No tools and minimal thinking reduce overhead, but the current model may be expensive. Each completed run adds an evaluation call until the goal completes or pauses.
- **`ms` intervals**: `parseInterval` accepts `Nms` (e.g. `/loop 500ms ...`), which yields sub-second loops. Use deliberately.
- No platform-specific behavior (no tmux/ghostty/macOS dependencies); persistence is plain fs.

## Install

```
pi install /Users/nicknisi/Developer/pi-extensions/packages/orchestrate
```

Add `<cwd>/.pi-goal/` to your global gitignore if you don't want state files showing up in repo status.
