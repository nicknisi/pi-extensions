# @nicknisi/pi-workflows

The model-facing front door to the first-party workflow engine. One `workflow` tool runs JavaScript workflow scripts that orchestrate subagents over the in-process runtime, replacing the third-party `@quintinshaw/pi-dynamic-workflows` extension. A `/wf` command is the thin human-facing wrapper.

## The platform story

Four pieces compose the workflow platform: `@nicknisi/pi-shared`'s **subagent runtime** (hermetic in-process child sessions), `@nicknisi/pi-codemode`'s **VM** approach (compile a model-written script in `node:vm` with injected bindings), `@nicknisi/pi-shared`'s **`workflow.ts` engine** (declarative multi-stage DAGs with needs/foreach/gates/retries), and **this tool** as the model-facing front door that ties them together with the script contract the old third-party engine used. The third-party `@quintinshaw/pi-dynamic-workflows` engine is being evicted — its script contract lives on unchanged here, its built-in pattern library / model tiers / agent-type registry / trigger-word arming do not.

## What it adds

- **`workflow` tool** (model-facing) — actions: `run` (inline JS `script` OR `name` of a saved workflow file), `list`, `status <runId>`, `stop <runId>`.
- **`/wf` command** (human-facing) — `/wf list | /wf run <name> [argsJson] | /wf status <runId> | /wf stop <runId>`.

## The script contract

A workflow script is a JavaScript **statement body** (no imports) with a leading `export const meta = { name, description }` declaration and a trailing `return value`. The body is wrapped in an async function so a top-level `return` compiles; `export const meta =` is rewritten so `node:vm` compiles it (a stranded `export` fails loudly) and `meta.name`/`meta.description` surface in the result.

Injected globals — the exact names the old third-party tool's scripts use, so existing scripts run unchanged:

```js
export const meta = { name: 'research', description: 'parallel research fan-out' };

const questions = ['How does the auth refresh flow work?', 'Where are sessions persisted?'];
const results = await parallel(questions.map((q) => () => agent(q, { label: 'researcher' })));
return { answered: results.length, results };
```

| Global                       | Behavior                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent(prompt, opts)`        | Spawns a hermetic in-process child via the subagent runtime (namespace `workflows`). Throws `${kind}: ${error}` on failure — wrap with a `safeAgent` that returns `{ ok, value, error }` so a failure inside `parallel()` reports which stage died instead of collapsing the wave to `null`. Returns `res.data ?? res.text ?? null`. |
| `parallel(thunks)`           | `Promise.all` over zero-arg thunks — pass `() => agent(...)`, not `agent(...)`.                                                                                                                                                                                                                                                      |
| `pipeline(items, ...stages)` | Folds items through stages: each stage maps over the previous stage's outputs in parallel, producing the next array.                                                                                                                                                                                                                 |
| `phase(name)`                | Logging marker only — NOT a budget boundary. Appends `── name` to the result logs.                                                                                                                                                                                                                                                   |
| `log(...args)`               | Captured into the result logs.                                                                                                                                                                                                                                                                                                       |
| `args`                       | The `args` JSON value passed to `run`.                                                                                                                                                                                                                                                                                               |
| `budget`                     | `{ total, spent, remaining }` over the run's token usage. `total` defaults to `Infinity`; `spent` accumulates across `agent()` calls. Read-only.                                                                                                                                                                                     |
| `cwd`                        | The session working directory.                                                                                                                                                                                                                                                                                                       |

`agent()` opts: `model` (`'provider/id'`), `tools` (allowlist — default read-only `['read','grep','find','ls']`; pass `['read','bash','edit','write']` for builders), `label` (child agent label), `systemPrompt`, `schema` (validated; parsed JSON lands in `result.data`), `effort` (thinking level), `timeoutMs`, `maxTurns`, `worktree` (run the child in an isolated git worktree; on settle the change set is captured to a `.patch` and `agent()` returns `{ value, patchPath, runId }` instead of the bare value — opt-in, so non-worktree calls are unchanged), `agentType` (accepted but ignored — no agent-type registry; resolve `systemPrompt` in the script itself).

The script executes **in the host process with full Node access** — `process`, `require`, and `fs` are all reachable, the same trust boundary as the `bash` tool. Keep the returned value small: summaries, counts, key findings — never raw file dumps.

## Saved workflows

Plain files. The registry is `ls` — no database, no manifest, no config keys.

- `~/.pi/agent/workflows/*.js` — global.
- `.pi/workflows/*.js` — project-local, **trusted projects only** (the same trust gate as codemode's `/cx`). Untrusted projects see only global workflows.

Names are bare file stems (`research`, not `research.js`, never a path — `..` and `/` are rejected to prevent escaping the workflows dirs). Global shadows a same-named project workflow. Files are read on demand, so `/reload` needs no workflow-specific wiring.

## Runs are visible

Every `agent()` call spawns through `@nicknisi/pi-shared`'s subagent runtime with `artifactsDir` set to `~/.pi/agent/subagent-runs/`, namespace `workflows`, and the owning Pi session recorded. Active children therefore appear in that session's default `fleet` view; settled and machine-wide records remain available through the fleet's explicit `all` scope. `status <runId>` and `stop <runId>` here read from / cancel via the same runtime's run records — no parallel store. `stop` cancels in-flight spawns through a live `runId → AbortController` registry (mirroring subagents' cascading-cancellation); a run belonging to a different host process is reported as not cancellable from here.

## Migration from `@quintinshaw/pi-dynamic-workflows`

| Old concept                                          | New home                                                                                                                                                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in named patterns (e.g. `research`, `review`)  | Example `.js` files you drop in `~/.pi/agent/workflows/`. No built-in library — the registry is `ls`.                                                                                                          |
| Model tiers (`fast` / `balanced` / `deep`)           | Explicit `model:` strings passed to `agent(prompt, { model: 'anthropic/claude-haiku-4-5' })`. No tier registry.                                                                                                |
| `agentType` → tool/systemPrompt resolution           | Resolve `systemPrompt` in the script itself: `agent(prompt, { systemPrompt: 'You are a reviewer…', tools: ['read','grep','bash'] })`. `agentType` is accepted but ignored (logged).                            |
| Trigger-word arming (the tool activates on keywords) | The model calls the `workflow` tool when intent warrants — no arming, no keyword matching.                                                                                                                     |
| Phases with per-phase budgets                        | `phase(name)` is a logging marker only. Budget is a single run-level `{ total, spent, remaining }`; per-stage budgets are the `workflow.ts` engine's `tokenBudget` (use `runWorkflow` from codemode for that). |
| The third-party engine's script globals              | Unchanged: `args`, `agent`, `parallel`, `pipeline`, `phase`, `log`, `budget`, `cwd`. Existing scripts run as-is.                                                                                               |

## Recipes

The `examples/` directory ships standalone, copy-and-adapt workflow scripts — the registry is `ls`, so these are code you read and copy, never APIs you import (no index re-exports them). Drop any of them into `~/.pi/agent/workflows/` and run via `/wf run <name>`.

- **`lanes.js`** — N parallel agents editing FILE-DISJOINT lanes of one repo under a hard-rules preamble (each lane owns a fixed file set; no git, no installs; the parent integrates centrally). Use it when a task splits into independent edits that don't overlap on files. Adapt by setting `VERIFY` to your typecheck command and filling the `LANES` array with `{ name, files, brief }` per lane.
- **`gates.js`** — three judge/verify prompt builders returning prompt strings: adversarial refutation (defeats confirmation bias), deep-research coverage (defeats silent source omission), and a 3-way code-review verdict (defeats verdict collapse). Use it when you need a reliable gate inside your own workflow. Adapt by copying the builder whose failure mode you need and calling it from an `agent()` with a JSON schema. Prompt patterns distilled from `@quintinshaw/pi-dynamic-workflows`.
- **`bake-off.js`** — race N models on the SAME task in isolated worktrees (`worktree: true`), then an advisory judge reads each contender's `.patch` and picks a winner. Use it on hard build tasks where a single GLM-5.2-class builder produces decent-but-flawed code; the 2x token cost buys a measurably better hit rate. Adapt by setting `CONTENDERS` to the models to race and passing `task` in `args`; the workflow returns the winner's `patchPath` to apply via `/patches`.

## Dependencies

- `@nicknisi/pi-shared` (`workspace:*`) — the subagent runtime and `runWorkflow` engine.
- `typebox` — the tool's parameter schema.
- `@earendil-works/pi-coding-agent` (peer) — the extension API, `getAgentDir`, `CONFIG_DIR_NAME`.

## Caveats

- The script runs in the host process with full Node access — the same trust boundary as the `bash` and `codemode` tools. Your model, your session.
- Project-local workflows (`.pi/workflows/`) load only in trusted projects; untrusted projects are limited to global workflows so a cloned repo cannot silently inject orchestration scripts.
- `agent()` cannot spawn children of its own (the ecosystem recursion guard refuses nested orchestration). For dependent multi-stage work where stages spawn, use `@nicknisi/pi-codemode`'s `runWorkflow` instead.
- `stop` cancels only runs spawned by this host process; persisted runs from other hosts show in `status` but are not cancellable here.
