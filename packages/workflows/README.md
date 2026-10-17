# @nicknisi/pi-workflows

The model-facing front door to the first-party workflow engine. One `workflow` tool runs JavaScript workflow scripts that orchestrate subagents over the in-process runtime, replacing the third-party `@quintinshaw/pi-dynamic-workflows` extension. A `/wf` command is the thin human-facing wrapper.

## The platform story

Three pieces compose the workflow platform: `@nicknisi/pi-shared`'s **subagent runtime** (hermetic in-process child sessions), `@nicknisi/pi-shared`'s **`workflow.ts` engine** (declarative multi-stage DAGs with needs/foreach/gates/retries), and **this tool** as the model-facing front door (compiling the model-written script in `node:vm` with injected bindings) that ties them together with the script contract the old third-party engine used. The third-party `@quintinshaw/pi-dynamic-workflows` engine is being evicted — its script contract lives on unchanged here, its built-in pattern library / model tiers / agent-type registry / trigger-word arming do not.

## What it adds

- **`workflow` tool** (model-facing) — actions: `run` (inline JS `script`, `name` of a saved workflow file, or `relaunch` of an earlier run), `list`, `status [runId]`, `stop <runId>`, `pause [runId]`, `resume [runId]`. Runs start in the background and return a `wf-xxxxxxxx` id at once; the result arrives as a message that starts a new turn.
- **Ultracode** — `/ultracode` (or `--ultracode`, or `"ultracode": true` in `~/.pi/agent/configs/workflows.json`) makes the model plan a workflow for every substantive task; the word `ultracode` in a prompt you type opts just that task in. See [Ultracode](#ultracode).
- **`/workflows` command** — live progress view (runs → phases → agents → agent detail). See [Watch a run](#watch-a-run).
- **Saved workflows as commands** — every saved workflow also runs as `/<name> [args]` (unless the name is taken by another command).
- **`/wf` command** (human-facing) — `/wf list | /wf run <name> [argsJson] | /wf relaunch <id> | /wf save <id> [name] | /wf status [id] | /wf stop <id> | /wf pause [id] | /wf resume [id]`.
- **Human gates inside scripts** — `checkpoint(label?)` pauses the run on a confirm dialog (reject/dismiss stops the run); `ask(question, options?)` asks mid-run (select with options, yes/no without, `undefined` when dismissed).
- **Footer status** — while a run is active the footer shows `wf <name> [running|paused] <last phase> · <done>/<agents>` (or `wf <n> runs` for several).
- **`autoplan` skill** — teaches the model the "autoplan this" trigger: run the saved `autoplan` workflow with args derived from the conversation, then respect the run's decision outcome. Disable with `"skills": ["-skills/autoplan"]` on the package entry.

## The script contract

A workflow script is a JavaScript **statement body** (no imports) with a leading `export const meta = { name, description }` declaration and a trailing `return value`. The body is wrapped in an async function so a top-level `return` compiles; `export const meta =` is rewritten so `node:vm` compiles it (a stranded `export` fails loudly) and `meta.name`/`meta.description` surface in the result.

Injected globals — the exact names the old third-party tool's scripts use, so existing scripts run unchanged:

```js
export const meta = { name: 'research', description: 'parallel research fan-out' };

const questions = ['How does the auth refresh flow work?', 'Where are sessions persisted?'];
const results = await parallel(questions.map((q) => () => agent(q, { label: 'researcher' })));
return { answered: results.length, results };
```

| Global                       | Behavior                                                                                                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent(prompt, opts)`        | Spawns a hermetic in-process child via the subagent runtime (namespace `workflows`). Returns `res.data ?? res.text ?? null`. Awaited directly, a failure throws `${kind}: ${error}`; inside `parallel()`/`pipeline()` it becomes `null` instead (see below). |
| `parallel(thunks)`           | Runs zero-arg thunks concurrently — pass `() => agent(...)`, not `agent(...)`. A thunk whose `agent()` fails resolves to `null` (and the failure is logged) so one failure doesn't collapse the wave; any other error still fails the run.                   |
| `pipeline(items, ...stages)` | Folds items through stages: each stage maps over the previous stage's outputs in parallel. An item whose agent failed stays `null` and skips later stages, so finish with `.filter(Boolean)`.                                                                |
| `phase(name)`                | Logging marker that also drives the footer status (`wf <name> [state] <phase>`). NOT a budget boundary.                                                                                                                                                      |
| `log(...args)`               | Captured into the result logs.                                                                                                                                                                                                                               |
| `checkpoint(label?)`         | Human gate: suspends the run on a confirm dialog; rejecting throws and stops the run. Without a UI host it is a logged no-op. Put it before destructive or expensive steps.                                                                                  |
| `ask(question, options?)`    | Human answer mid-run: a select when `options` are given, a yes/no confirm otherwise; `undefined` when dismissed. Without a UI host it throws — never invent an answer.                                                                                       |
| `args`                       | The `args` JSON value passed to `run`.                                                                                                                                                                                                                       |
| `budget`                     | `{ total, spent, remaining }` over the run's token usage. `total` defaults to `Infinity`; `spent` accumulates across `agent()` calls. Read-only.                                                                                                             |
| `cwd`                        | The session working directory.                                                                                                                                                                                                                               |

`agent()` opts: `model` (`'provider/id'`), `tools` (allowlist — default read-only `['read','grep','find','ls']`; pass `['read','bash','edit','write']` for builders), `label` (child agent label), `systemPrompt`, `schema` (validated; parsed JSON lands in `result.data`), `effort` (thinking level), `timeoutMs`, `stallMs` (restart window, below), `maxTurns`, `worktree` (run the child in an isolated git worktree; on settle the change set is captured to a `.patch` and `agent()` returns `{ value, patchPath, runId }` instead of the bare value — opt-in, so non-worktree calls are unchanged), `agentType` (accepted but ignored — no agent-type registry; resolve `systemPrompt` in the script itself).

`agent()` awaits the run's pause gate before every spawn: `pause` lets the in-flight step finish, then holds the run before the next one; `resume` releases it. Pause/resume take a workflow id, or apply to every active run without one. Stopping or timing out a run aborts the gate, so a parked run rejects instead of hanging.

The script executes **in the host process with full Node access** — `process`, `require`, and `fs` are all reachable, the same trust boundary as the `bash` tool. Keep the returned value small: summaries, counts, key findings — never raw file dumps.

## Limits

| Limit                                    | Value                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concurrent agents                        | 16 by default, fewer on machines with fewer CPUs. Set `PI_WORKFLOW_MAX_CONCURRENT` (1–256) to change it. Extra agents queue.                                                                                                                                                                                   |
| Agents per run                           | 1,000 — a runaway guard; the next `agent()` throws.                                                                                                                                                                                                                                                            |
| Items per `parallel()`/`pipeline()` call | 4,096 — a longer list throws instead of silently dropping work.                                                                                                                                                                                                                                                |
| Stalled agents                           | An agent with no output for 5 minutes (time inside its tool calls excluded) restarts from the same prompt, at most 5 times; then `agent()` fails with `stalled: agent stalled on all 6 attempts`. Set `stallMs` per call or `PI_WORKFLOW_STALL_MS` (0 disables). Files a stalled attempt changed stay changed. |
| Structured output                        | With `schema`, the agent is told the JSON Schema; an invalid answer is corrected in-session (5 attempts in total) before `agent()` fails with `schema_invalid`.                                                                                                                                                |

## Ultracode

Two ways to get workflows without writing the script yourself, matching Claude Code:

- **One task:** include the word `ultracode` in a prompt you type (`ultracode: audit every route under src/routes/ for missing auth`). That turn gets an instruction to run the task as a workflow. The keyword counts only in prompts typed in the terminal UI or sent by an RPC client — not in print mode (`pi -p`), slash commands, or text other extensions send.
- **Whole session:** `/ultracode` toggles it (`/ultracode on|off`). While on, the system prompt asks the model to plan and run a workflow for every substantive task (understand → change → verify, one agent per independent item, independent verification of findings) and to skip trivial requests. The footer shows `ultracode`. Start a session with it on with `pi --ultracode`, or make it the default:

```json
// ~/.pi/agent/configs/workflows.json
{ "ultracode": true }
```

Ultracode only changes how the model structures work; it doesn't change your thinking level or model. Every request uses more tokens and takes longer, so turn it off for routine work. Either route activates the `workflow` tool if `tool_search` was keeping it deferred.

## Background runs and relaunch

`run` starts the workflow in the background and returns its id (`wf-xxxxxxxx`) immediately, so the session stays responsive. When the run ends, its result (or error) is delivered as a `workflows:result` message; for model-started runs that message starts a new turn so the model can act on it. Pass `background: false` when a caller needs the value inside the same tool call (for example a codemode script). Without a UI (print mode, which exits when the turn ends) runs default to the foreground. There is no wall-clock cap unless you pass `timeoutMs`. Background runs stop when the session ends.

Every run writes its script, `run.json` (label, args, status), and `journal.jsonl` to `~/.pi/agent/workflow-runs/<id>/` (or `$PI_SUBAGENTS_DIR/workflow-runs/`); run dirs older than 7 days are swept. The journal records each settled agent in start order with a hash of everything that determines its work (prompt, model, tools, system prompt, schema, …).

`run` with `relaunch: '<id>'` (or `/wf relaunch <id>`) re-runs a stopped or failed workflow with the same script and args. Agents replay in start order: each completed agent whose inputs match returns its saved result without running; the first agent that differs, failed, or never finished — and every agent after it — runs again. Pass `script` along with `relaunch` to relaunch an edited version. Keep scripts deterministic (no `Date.now()` or `Math.random()` in prompts; pass timestamps through `args`) so a relaunch starts the same agents in the same order.

## Watch a run

`/workflows` opens a live view of this session's runs; with a single run it opens that run directly (`/workflows <id>` picks one). Each run shows its phases with agent counts; drill into a phase to see its agents (status, tokens, attempts) and into an agent to read its prompt, error, and result.

| Key           | Action                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `↑` / `↓`     | Select a run, phase, or agent                                                                      |
| `Enter` / `→` | Drill in                                                                                           |
| `Esc` / `←`   | Back out one level (closes at the top)                                                             |
| `j` / `k`     | Scroll the agent detail                                                                            |
| `f`           | Filter a phase's agents: all → running → done → failed                                             |
| `p`           | Pause or resume the run                                                                            |
| `x`           | Stop the selected agent (it becomes `null` in its wave), or the whole run from the run/phase level |
| `r`           | Restart the selected running agent from the same prompt                                            |
| `s`           | Save the run's script as a workflow command                                                        |

Outside the terminal UI, `/workflows` prints the same status as `/wf status`.

## Saved workflows

Plain files. The registry is `ls` — no database, no manifest, no config keys.

- `~/.pi/agent/workflows/*.js` — global.
- `.pi/workflows/*.js` — project-local, **trusted projects only**. Untrusted projects see only global workflows.

Names are bare file stems (`research`, not `research.js`, never a path — `..` and `/` are rejected to prevent escaping the workflows dirs). Global shadows a same-named project workflow. Files are read on demand.

Each saved workflow is also registered as `/<name> [args]` at session start (arguments are parsed as JSON when possible, otherwise passed as a string). A name already used by another command keeps that command; run the workflow with `/wf run <name>` instead. `/reload` picks up new files.

To save a run you liked, press `s` in `/workflows` or run `/wf save <id> [name]`. Without a name you're asked for one and, in a trusted project, whether to save to `.pi/workflows/` (shared with the repo) or `~/.pi/agent/workflows/` (only you). The command is available immediately.

## Runs are visible

Every `agent()` call spawns through `@nicknisi/pi-shared`'s subagent runtime with `artifactsDir` set to `~/.pi/agent/subagent-runs/` (or `$PI_SUBAGENTS_DIR/runs/`), namespace `workflows`, and the owning Pi session recorded. Children use the parent session's model registry and, when a call names no model, its current model (see [subagents](../subagents/README.md#models-children-use-the-parents-registry)). Active children therefore appear in that session's default `fleet` view; settled and machine-wide records remain available through the fleet's explicit `all` scope. `status`/`stop` accept a workflow id (`wf-…`, the whole run) or an agent run id (one child), read from / cancelling via the same runtime's run records — no parallel store. `stop` cancels in-flight spawns through a live `runId → AbortController` registry (mirroring subagents' cascading-cancellation); a run belonging to a different host process is reported as not cancellable from here.

## Migration from `@quintinshaw/pi-dynamic-workflows`

| Old concept                                          | New home                                                                                                                                                                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in named patterns (e.g. `research`, `review`)  | Example `.js` files you drop in `~/.pi/agent/workflows/`. No built-in library — the registry is `ls`.                                                                                                                        |
| Model tiers (`fast` / `balanced` / `deep`)           | Explicit `model:` strings passed to `agent(prompt, { model: 'anthropic/claude-haiku-4-5' })`. No tier registry.                                                                                                              |
| `agentType` → tool/systemPrompt resolution           | Resolve `systemPrompt` in the script itself: `agent(prompt, { systemPrompt: 'You are a reviewer…', tools: ['read','grep','bash'] })`. `agentType` is accepted but ignored (logged).                                          |
| Trigger-word arming (the tool activates on keywords) | The model calls the `workflow` tool when intent warrants — no arming, no keyword matching.                                                                                                                                   |
| Phases with per-phase budgets                        | `phase(name)` is a logging marker only. Budget is a single run-level `{ total, spent, remaining }`; per-stage budgets are the `workflow.ts` engine's `tokenBudget` (call `runWorkflow` from `@nicknisi/pi-shared` for that). |
| The third-party engine's script globals              | Unchanged: `args`, `agent`, `parallel`, `pipeline`, `phase`, `log`, `budget`, `cwd`. Existing scripts run as-is.                                                                                                             |

## Recipes

The `examples/` directory ships standalone, copy-and-adapt workflow scripts — the registry is `ls`, so these are code you read and copy, never APIs you import (no index re-exports them). Drop any of them into `~/.pi/agent/workflows/` and run via `/wf run <name>`.

- **`lanes.js`** — N parallel agents editing FILE-DISJOINT lanes of one repo under a hard-rules preamble (each lane owns a fixed file set; no git, no installs; the parent integrates centrally). Use it when a task splits into independent edits that don't overlap on files. Adapt by setting `VERIFY` to your typecheck command and filling the `LANES` array with `{ name, files, brief }` per lane.
- **`gates.js`** — three judge/verify prompt builders returning prompt strings: adversarial refutation (defeats confirmation bias), deep-research coverage (defeats silent source omission), and a 3-way code-review verdict (defeats verdict collapse). Use it when you need a reliable gate inside your own workflow. Adapt by copying the builder whose failure mode you need and calling it from an `agent()` with a JSON schema. Prompt patterns distilled from `@quintinshaw/pi-dynamic-workflows`.
- **`bake-off.js`** — race N models on the SAME task in isolated worktrees (`worktree: true`), then an advisory judge reads each contender's `.patch` and picks a winner. Use it on hard build tasks where a single GLM-5.2-class builder produces decent-but-flawed code; the 2x token cost buys a measurably better hit rate. Adapt by setting `CONTENDERS` to the models to race and passing `task` in `args`; the workflow returns the winner's `patchPath` to apply via `/patches`.
- **`autoplan.js`** — 3 solution candidates in parallel + a Holy Grail pass, an advisor that ranks with a recommendation (curbing Grail ideas that need upstream changes), then the HUMAN decides via `ask()` — recommendation on top, reject-all always offered — and the chosen option gets the full plan write. Ported from osolmaz/pi-workflows' decision-gate demo. Pass `{ problem, scope, constraints }` in `args`, or say "autoplan this" and the bundled `autoplan` skill derives the args from the conversation.
- **`sanity-check.js`** — read-only contribution review: evidence collection, four parallel area reviewers (necessity, duplication, contracts, scope/tests), then a verifier that tries to REFUTE every finding before the keep/simplify/refactor/drop/needs-evidence verdict. Ported from osolmaz/pi-workflows. Pass `{ baseRef }` in `args`.
- **`autoimplement.js`** — implement a supplied plan (never devises one) behind an `ask` plan gate, then a bounded build → verify → review/fix loop where P0/P1 block and the round cap prevents an unbounded fix spiral. Ported from osolmaz/pi-workflows. Pass `{ task, plan, verify }` in `args`.

## Dependencies

- `@nicknisi/pi-shared` (`workspace:*`) — the subagent runtime and `runWorkflow` engine.
- `typebox` — the tool's parameter schema.
- `@earendil-works/pi-coding-agent` (peer) — the extension API, `getAgentDir`, `CONFIG_DIR_NAME`.

## Tool exposure

`workflow` registers with `exposure: "deferred"` (pi ≥0.99), so it stays out of the system prompt when pi's built-in `tool_search` is active (`"defaultTools": ["+tool_search"]`): the model finds it on demand. Without `tool_search` the extension declares it directly at session start, as before. Older pi ignores the field. It also carries `annotations` (read-only/destructive/open-world hints) for permission extensions.

## Caveats

- The script runs in the host process with full Node access — the same trust boundary as the `bash` tool. Your model, your session.
- `checkpoint`/`ask` need an interactive UI host. In a headless/RPC host `checkpoint` degrades to a logged no-op and `ask` throws — scripts that require an answer fail loudly instead of inventing one.
- Pause/resume are best-effort for tool-initiated runs: slash commands may queue behind an in-flight turn, so a `pause` issued mid-turn engages at the next `agent()` boundary after it's processed. For a guaranteed human gate, put `checkpoint`/`ask` in the script itself.
- `checkpoint`/`ask` dialogs in a background run can appear while you're typing.
- Relaunch replays results, not side effects: files a completed agent changed stay changed, and a replayed agent doesn't run again. Relaunch works for runs in `~/.pi/agent/workflow-runs/`, including runs from an earlier pi process.
- Project-local workflows (`.pi/workflows/`) load only in trusted projects; untrusted projects are limited to global workflows so a cloned repo cannot silently inject orchestration scripts.
- `agent()` cannot spawn children of its own (the ecosystem recursion guard refuses nested orchestration). For dependent multi-stage work where stages spawn, use the `@nicknisi/pi-shared` `runWorkflow` engine directly.
- `stop` cancels only runs spawned by this host process; persisted runs from other hosts show in `status` but are not cancellable here.
