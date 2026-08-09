# @nicknisi/pi-codemode

Codemode for the first-party subagent platform: the model writes TypeScript that orchestrates subagents **compositionally** — `Promise.all` fan-out, sequential pipelines, map/reduce over files — and the `codemode` tool compiles and runs it in-process, returning the module's default export as the result. Rebuilt on `@nicknisi/pi-shared`'s in-process runtime; no pi-subagents dependency, no pi-mcp-adapter.

It also ships a **console**: an `=` editor prefix and `/cx` named snippets that run the same runtime inline (devtools-console style), with returned values bound to `$1`, `$2`, … for later snippets. See [Console](#console).

## What it adds

- **`codemode` tool** (model-facing) — params: `{ code: string; label?: string; timeoutMs?: number }` (default 10 min, capped at 30 min). The snippet gets two injected bindings and must `export default` its result.
- **Runscope orchestration ledger** (parent-session side effect) — every `spawn`/`runWorkflow` lifecycle event is appended to the _parent_ session as a typed custom entry (`customType: 'codemode-runscope'`). See [Runscope ledger](#runscope-ledger).
- **`=` console prefix** (TUI editor) — `=<snippet>` runs a snippet inline and renders the result as a collapsible block. See [Console](#console).
- **`/cx` named snippets** (slash command) — run named snippet files from `~/.pi/agent/snippets/` or `.pi/snippets/`. See [`/cx` named snippets](#cx-named-snippets).

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

## Console

The `codemode` tool is model-facing, but codemode also runs the same runtime **inline** from the editor, devtools-console style. Returned values bind to `$1`, `$2`, … for later snippets in the session, and every run is persisted as a session custom entry so the console history survives reload. The model-facing `codemode` tool does **not** bind to `$N` — only the console does.

### `=` console prefix

pi's editor prefix grammar: `!` = bash, `!!` = silent bash, `@` = files. codemode adds the `=` member:

```
=const x = await spawn({ prompt: 'list top-level exports', tools: ['read','grep'], text: true });
export default x.ok ? x.text : x.error
```

`=<snippet>` at position zero runs the snippet through the same codemode runtime as the `codemode` tool. The result renders as a collapsible block (toggled with the same `app.tools.expand` key — `ctrl+o` by default — as tool output), with the returned value bound to the next `$N` and the run persisted as a `codemode-console` custom entry.

The `=` prefix is intercepted via `on("input")` with `{ action: "handled" }` — the documented mechanism that skips the agent entirely. Only the TUI editor prefix is intercepted; extension-injected messages and non-tui (`rpc`/`json`/`print`) inputs pass through unchanged. It respects the same schema-or-nothing `spawn()` contract as the tool.

Reference a previous console result with `$1`, `$2`, …:

```
=export default `previous had ${($1 as string[]).length} items`
```

### `/cx` named snippets

Named codemode snippets as plain TS/JS files discovered from:

- Global: `~/.pi/agent/snippets/*.{ts,js}`
- Project: `.pi/snippets/*.{ts,js}` (only after the project is trusted)

mirroring pi's prompt-template discovery conventions. Files carry optional frontmatter (`description`) for the autocomplete dropdown:

```ts
---
description: Summarize a file's public API
---
const file = await spawn({ prompt: `Summarize the public API of {{1}}.`, tools: ['read'], text: true });
export default file.ok ? file.text : file.error
```

`/cx <name> [args...]` expands `{{args}}`-style substitution then runs the snippet via codemode:

- `{{args}}` or `{{@}}` — all args joined
- `{{N}}` — positional arg (1-indexed); empty string when missing
- `{{N:-default}}` — positional with a default
- unknown `{{...}}` is left intact so typos are visible

```
/cx summarize src/index.ts
/cx review src/auth.ts src/session.ts
```

This is a **directory convention ONLY** — no registry, no index, no config keys. The registry is `ls`; the package manager is `git`; the search engine is `grep`. Snippets are read on demand each invocation, so discovery rides `/reload` with no snippet-specific wiring. Completion for the first token lists global snippet names on demand; project snippets (untrusted) are not in the completion list but still run.

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

## Recipes

### Adversarial gauntlet

A self-contained quality gate: one **builder** stage (`sharesTree: true`) edits the tree, a synchronous **critic gate** reads the _real_ resulting `git diff HEAD` and forces the builder to revise up to `maxGateAttempts: 3` times. A second, independent **critic** stage then reviews the captured `treeDiffs['builder']` — the ground-truth diff that `sharesTree` hands to dependents — and emits a final pass/fail. No new runtime code; this is plain `runWorkflow` over the existing engine.

```ts
import { execSync } from 'node:child_process';

const TARGET = 'src/auth.ts';
const MAX_ADDED_LINES = 400;

function critic(diff: string): string[] {
  const issues: string[] = [];
  if (!new RegExp(`diff --git a/${TARGET}`).test(diff)) issues.push(`did not touch ${TARGET}`);
  if (!/\.test\.ts\b/.test(diff)) issues.push('no test file changed');
  if (/console\.log|debugger/.test(diff)) issues.push('contains console.log / debugger');
  const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  if (added > MAX_ADDED_LINES) issues.push(`diff is ${added} added lines (>${MAX_ADDED_LINES})`);
  return issues;
}

const result = await runWorkflow({
  name: 'adversarial-gauntlet',
  stages: [
    {
      id: 'builder',
      agent: 'builder',
      sharesTree: true,
      tools: ['read', 'bash', 'edit', 'write'],
      prompt: `Implement the refresh-token rotation fix in ${TARGET}. Add or update a test. Keep the diff tight.`,
      maxGateAttempts: 3,
      gate: (outcome) => {
        // The builder's spawn has resolved, so the working tree holds its edits.
        // Read the REAL resulting diff synchronously and critique it.
        let diff = '';
        try {
          diff = execSync('git diff HEAD', { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
        } catch {
          return { revise: 'Could not read `git diff HEAD` — is this a git repo?' };
        }
        if (!diff.trim()) return { revise: 'Working tree is clean — no changes to critique.' };
        const issues = critic(diff);
        return issues.length === 0 ? true : { revise: 'Critic issues:\n- ' + issues.join('\n- ') };
      },
    },
    {
      id: 'critic',
      agent: 'critic',
      tools: ['read', 'grep', 'find', 'ls'],
      needs: ['builder'],
      prompt: (ctx) =>
        `Review this diff for correctness and security. Report pass/fail with concrete issues.\n\n${ctx.treeDiffs['builder'] ?? '(no diff captured)'}`,
    },
  ],
});

const b = result.outcomes['builder'];
const c = result.outcomes['critic'];
export default {
  ok: result.ok,
  builderAttempts: b?.attempts,
  builder: result.ok ? 'passed the gauntlet' : `failed (${b && !b.ok ? b.kind : '?'}): ${b && !b.ok ? b.error : ''}`,
  critic: c && c.ok ? c.output : `critic did not run (${c && !c.ok ? c.kind : '?'}): ${c && !c.ok ? c.error : ''}`,
  runDir: result.runDir,
};
```

**When to use.** You have a concrete, checkable contract for a change (must touch a file, must add a test, must stay under N lines, must not reintroduce a banned pattern) and want the builder to iterate against it autonomously instead of you hand-holding each round. The `sharesTree` diff also flows downstream, so the independent critic stage reviews ground truth rather than the builder's self-report.

**Pitfalls.**

- **The gate runs synchronously, before the engine captures `treeDiffs`.** It cannot be an `async` LLM call — `runWorkflow` does not await the gate, so a Promise would be treated as a non-`true` object with an undefined `revise`. The critic gate is therefore deterministic (regex/structural checks over the real diff). For an LLM critic over the captured diff, use a downstream stage like `critic` above — but note downstream stages **do not loop back** into the builder, so the autonomous revise loop lives entirely in the builder's own `gate`/`maxGateAttempts`.
- **`execSync` blocks the host event loop.** `git diff HEAD` is fast, but keep the gate's work bounded — never shell out to anything slow. The codemode timeout cannot preempt synchronous JS.
- **Node builtins import fine; `node_modules` does not.** `import { execSync } from 'node:child_process'` is externalized by bundle-require and resolves at runtime; bare package imports fail (no `node_modules` near the temp dir). The snippet API (`spawn`/`runWorkflow`/`log`) is injected globals, not imports.
- **The gate sees the real diff, not the bounded 64 KB `treeDiffs` handoff.** A builder producing a huge diff passes the gate's line cap but still truncates for downstream stages — keep `MAX_ADDED_LINES` under the 64 KB budget if downstream consumers need the full diff.

## Security model

The snippet executes **in-process with the host's full privileges**. This is the same trust boundary as any `bash` tool call and as the original pi-codemode: it's your model, writing code for your session, on your machine. There is no sandbox. Do not point it at untrusted prompt sources.

## Configuration

None.

## Caveats

- **No crash isolation.** A pathological snippet (memory bomb, infinite sync loop) hurts the host. The timeout cannot preempt CPU-bound synchronous code — it aborts in-flight subagents and stops awaiting, but JS can't be killed mid-`while(true)`. Never write busy-wait or long synchronous loops: they block the host event loop and can freeze the session.
- **Executions are serialized.** Runs queue behind each other because snippet bindings are passed through a single global; concurrent `codemode` calls do not run in parallel. The `=` console and `/cx` share this same queue and the same runtime as the tool.
- **`$N` binding is JSON on reload.** Within a live session, `$1`… hold the raw default export (no serialization). On reload, `$N` are rebuilt from the persisted `codemode-console` entries, which are JSON — so non-JSON values (functions, symbols, class instances) are lost or simplified. Errored console runs are not bound to a `$N`.
- **Timeout semantics:** on expiry, in-flight `spawn` calls (including every stage of an in-flight `runWorkflow`) are aborted (children stop quickly) and the tool returns a timeout error with captured logs; the detached snippet promise settles later and is discarded.
- **`export default` is required.** A missing/undefined default export returns a notice, not an error.
- **Results are bounded** (16 KB), logs are bounded (200 entries × 2 KB), stacks are bounded (4 KB).
- **bundle-require/ESM interop quirks:** the snippet is esbuild-bundled as ESM with target es2022 (top-level await works); bare package imports fail by design (no `node_modules` near the temp dir), but Node builtins and globals remain reachable — there is no sandbox.
- **Runscope volume:** every spawn emits two ledger entries, and a `foreach` fan-out of N items emits 2N. Entries persist to the session JSONL (never LLM context), so a large fan-out grows the session file — the trade-off for a durable trace. Emission is best-effort and never fails a run.
