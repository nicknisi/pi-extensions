# @nicknisi/pi-codemode

Codemode for the first-party subagent platform: the model writes TypeScript that orchestrates subagents **compositionally** — `Promise.all` fan-out, sequential pipelines, map/reduce over files — and the `codemode` tool compiles and runs it in-process, returning the module's default export as the result. Rebuilt on `@nicknisi/pi-shared`'s in-process runtime; no pi-subagents dependency, no pi-mcp-adapter.

## What it adds

- **`codemode` tool** (model-facing) — params: `{ code: string; label?: string; timeoutMs?: number }` (default 10 min, capped at 30 min). The snippet gets two injected bindings and must `export default` its result.
- **Runscope orchestration ledger** (parent-session side effect) — every `spawn`/`runWorkflow` lifecycle event is appended to the _parent_ session as a typed custom entry (`customType: 'codemode-runscope'`). See [Runscope ledger](#runscope-ledger).

## The snippet API

```ts
spawn(options: SpawnOptions): Promise<SpawnResult>;
runWorkflow(spec: WorkflowSpec, opts?): Promise<WorkflowResult>;
log(...args: unknown[]): void;
```

- `spawn` launches a hermetic in-process child agent through the shared runtime (namespace `codemode`). Children are version-matched to the host, cannot themselves spawn, and honor the ecosystem recursion guard. Run artifacts persist to `~/.pi/agent/subagent-runs/codemode/`, so codemode children appear in the `fleet` tool / `/fleet` command from `@nicknisi/pi-subagents`.
- `spawn` **never rejects**. Check `result.ok`; failures carry `kind: 'crashed' | 'empty' | 'schema_invalid' | 'aborted'` plus `error`.
- **Output contracts (breaking).** Every `spawn()` must declare its contract explicitly: either `outputSchema` (validated; parsed JSON lands in `result.data`) **or** `text: true` (raw text opt-in). A `spawn()` with **neither** throws immediately with an error naming the missing contract — it does _not_ return unparsed text. This prevents the silent failure mode where a schema-less spawn returns text, a caller reads a field off it (`result.someField`), gets `undefined`, and a whole parallel fleet reports success while every result is unusable. A schema-validating spawn that fails validation after one bounded repair attempt (a normalize-and-recheck pass) returns a loud recoverable failure: `{ ok: false, kind: 'schema_invalid', error, text }` — never a silently-empty string. **Migration:** add `text: true` to existing text-mode spawns, or define an `outputSchema`.
- `runWorkflow` runs a declarative multi-stage DAG over `spawn` (from `@nicknisi/pi-shared`'s engine): per-stage `needs` deps (default linear), `foreach` fan-out, `gate` revise-feedback loops, `retries`, `tokenBudget`, and `sharesTree` stages that never overlap other work and hand their bounded `git diff HEAD` to dependents. Control artifacts land in `~/.pi/agent/workflow-runs/`; `opts.resumeFrom` skips previously-ok stages. Also never rejects — per-stage outcomes carry `ok`/`kind`. Prefer it over hand-rolled `Promise.all` when stages depend on each other, need gates/retries, or edit the working tree.
- `SpawnOptions` highlights: `prompt` (required), `agent` (label), `model` (`'provider/id'`), `tools` (allowlist — `undefined` defaults to read-only `['read','grep','find','ls']`; pass `['read','bash','edit','write']` explicitly for builders), `systemPrompt`, `outputSchema` (validated; parsed JSON lands in `result.data`), `text` (boolean — opt into raw text mode; required when `outputSchema` is omitted), `cwd`, `timeoutMs`, `maxTurns`, `maxToolCalls`, `thinkingLevel`.
- `log` output comes back in the tool result's `details.logs`.

The snippet executes **in the host process with full Node access** — `process`, `require`, and `fs` are all reachable, the same trust boundary as the `bash` tool (see Security model). `spawn`, `runWorkflow`, and `log` are the injected codemode API. Composition is plain code: that's the point.

## Usage examples

Parallel research fan-out:

```ts
const questions = [
  'How does the auth refresh flow work?',
  'Where are sessions persisted?',
  'What breaks if the token endpoint 500s?',
];
const results = await Promise.all(
  questions.map((q) => spawn({ prompt: q, tools: ['read', 'grep', 'find', 'ls'], text: true })),
);
export default results.map((r, i) => ({
  question: questions[i],
  answer: r.ok ? r.text.slice(0, 500) : `FAILED (${r.kind}): ${r.error}`,
}));
```

Map/reduce over files with a pipeline:

```ts
const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
const summaries = [];
for (const f of files) {
  const r = await spawn({ prompt: `Summarize the public API of ${f} in 3 bullets.`, tools: ['read'], text: true });
  summaries.push({ file: f, summary: r.ok ? r.text : `failed: ${r.error}` });
}
const rollup = await spawn({
  prompt: `Combine these module summaries into one architecture paragraph:\n${JSON.stringify(summaries)}`,
  tools: [],
  text: true,
});
export default { rollup: rollup.ok ? rollup.text : 'rollup failed', summaries };
```

## Runscope ledger

Every `spawn` and `runWorkflow` lifecycle event is appended to the **parent** session as a custom entry via `pi.appendEntry('codemode-runscope', entry)`. Custom entries persist to the session JSONL but **do not enter LLM context**, so the ledger is durable and free of context-window cost. Dependency-free — no OpenTelemetry.

Entry shape (all fields except extras are guaranteed):

```ts
{
  runId: string; // workflow run id, or the spawn's own runId for a standalone spawn
  spanId: string; // this span (spawn runId, or stage id)
  parentSpanId: string | null; // containing stage span, or the first `needs` dep for a stage, or null
  kind: 'spawn_start' | 'spawn_end' | 'stage_start' | 'stage_end' | 'gate_result';
  ts: number; // epoch ms
  // extras (kind-dependent): ok, failureKind, error, passed, feedback
}
```

Events:

- **`spawn_start` / `spawn_end`** — around every `spawn`, standalone or inside a workflow stage. `spawn_end` carries `ok` and, on failure, `failureKind` + `error`.
- **`stage_start` / `stage_end`** — around every workflow stage (including skipped / budget-exceeded ones). `stage_end` carries `ok` and, on failure, `failureKind` + `error`.
- **`gate_result`** — emitted when a stage `gate` verdict is reached. Carries `passed: boolean` and, on revise, `feedback`.

**Trace tree.** Stage `parentSpanId` is derived from `needs` edges (default: the previous stage), so the stage span tree mirrors the workflow DAG. A trace span has one parent, so a multi-need stage attaches to its **first** need — a spanning tree of the DAG. Spawns inside a workflow are parented to their stage via `AsyncLocalStorage`, so concurrent stages attribute their spawns correctly. Standalone spawns (no workflow) have `parentSpanId: null`.

Read the ledger back by scanning `ctx.sessionManager.getEntries()` for `entry.type === 'custom' && entry.customType === 'codemode-runscope'` (e.g. on `session_start` to reconstruct a run view). Entries are not rendered in the transcript unless you register a renderer via `pi.registerEntryRenderer('codemode-runscope', ...)`.

## Security model

The snippet executes **in-process with the host's full privileges**. This is the same trust boundary as any `bash` tool call and as the original pi-codemode: it's your model, writing code for your session, on your machine. There is no sandbox. Do not point it at untrusted prompt sources.

## Configuration

None.

## Caveats

- **No crash isolation.** A pathological snippet (memory bomb, infinite sync loop) hurts the host. The timeout cannot preempt CPU-bound synchronous code — it aborts in-flight subagents and stops awaiting, but JS can't be killed mid-`while(true)`. Never write busy-wait or long synchronous loops: they block the host event loop and can freeze the session.
- **Executions are serialized.** Runs queue behind each other because snippet bindings are passed through a single global; concurrent `codemode` calls do not run in parallel.
- **Timeout semantics:** on expiry, in-flight `spawn` calls (including every stage of an in-flight `runWorkflow`) are aborted (children stop quickly) and the tool returns a timeout error with captured logs; the detached snippet promise settles later and is discarded.
- **`export default` is required.** A missing/undefined default export returns a notice, not an error.
- **Results are bounded** (16 KB), logs are bounded (200 entries × 2 KB), stacks are bounded (4 KB).
- **bundle-require/ESM interop quirks:** the snippet is esbuild-bundled as ESM with target es2022 (top-level await works); bare package imports fail by design (no `node_modules` near the temp dir), but Node builtins and globals remain reachable — there is no sandbox.
- **Runscope volume:** every spawn emits two ledger entries, and a `foreach` fan-out of N items emits 2N. Entries persist to the session JSONL (never LLM context), so a large fan-out grows the session file — the trade-off for a durable trace. Emission is best-effort and never fails a run.
