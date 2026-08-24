# @nicknisi/pi-codemode

## 0.3.0

### Minor Changes

- 44a6aad: Add configurable child model defaults via `~/.pi/agent/configs/codemode.json` (`childModel`, `childThinkingLevel`), falling back to the session's current model and thinking level. Raise child spawn concurrency from 4 to 6 (workflow default too; process-wide ceiling stays 8). Stream live progress into the tool row while a codemode run executes: running/done/failed spawn counts plus recent log lines via `onUpdate` partials. Fix a duplicated line in the tool description.

## 0.2.4

### Patch Changes

- Updated dependencies [7c6a68d]
  - @nicknisi/pi-shared@0.5.1

## 0.2.3

### Patch Changes

- 4fff6f8: Scope the default fleet command, shortcut, tool list, and footer indicator to active subagents owned by the current Pi session, with explicit `all` access to persisted machine-wide history. Propagate owner-session metadata through codemode and workflows without enabling session mirrors. Add a global statusline `hiddenStatuses` denylist for suppressing extension-provided footer segments.
- Updated dependencies [4fff6f8]
  - @nicknisi/pi-shared@0.5.0

## 0.2.2

### Patch Changes

- bfd02d7: Fix `Dynamic require of "node:fs" is not supported` errors in codemode snippets.

  Snippets that used CJS `require('node:...')` (which the tool description advertises as reachable) failed at runtime: esbuild bundles to ESM and rewrites those calls to a `__require` shim that throws when `require` is undefined in ESM scope. Inject a real CJS `require` (via `createRequire(import.meta.url)`) as an esbuild banner so the shim resolves to the genuine Node built-in instead of throwing.

## 0.2.1

### Patch Changes

- Updated dependencies [9cd49ce]
  - @nicknisi/pi-shared@0.4.0

## 0.2.0

### Minor Changes

- 484672a: codemode joins pi's editor prefix grammar (`!` bash, `!!` silent bash, `@` files) as the `=` member. `=<snippet>` at position zero runs the snippet through the codemode runtime inline, devtools-console style — the snippet executes with the same `spawn`/`log`/`runWorkflow` bindings as the `codemode` tool, the result renders as a collapsible block (toggled with the same `app.tools.expand` key as tool output), and the returned value binds to `$1`, `$2`, … for later console snippets in the session. Each run is persisted as a session custom entry (`customType: 'codemode-console'`) so the console history survives reload; `$1…` are rebuilt from those entries on session start. The `=` prefix is intercepted via `on("input")` with `{ action: "handled" }` (TUI only; extension-injected and non-tui inputs pass through) and respects the schema-or-nothing spawn contract.
- 484672a: `/cx <name> [args...]` runs a named codemode snippet discovered from plain TS/JS files in `~/.pi/agent/snippets/` (global) and `.pi/snippets/` (project, trusted only), mirroring pi's prompt-template discovery. Files carry optional frontmatter (`description`) for the autocomplete dropdown. `/cx` expands `{{args}}`-style substitution — `{{args}}`/`{{@}}` (all args), `{{N}}` (positional, 1-indexed), `{{N:-default}}` — then runs the snippet via the codemode runtime, binding the result to the next `$N` and persisting it as a `codemode-console` custom entry. This is a directory convention ONLY: no registry, no index, no config keys — the registry is `ls`, the package manager is `git`, the search engine is `grep`. Snippets are read on demand each invocation, so discovery rides `/reload` with no snippet-specific wiring.
- 9245fdc: codemode spawn() now requires an explicit output contract. A spawn with neither `outputSchema` nor `text: true` throws immediately instead of returning unparsed text. This prevents the silent failure mode where reading a field off unparsed text yields `undefined` while the run reports success. A schema-validating spawn that fails validation after its bounded repair attempt still returns `{ ok: false, kind: 'schema_invalid' }` — never a silently-empty string. Migration: add `text: true` to existing text-mode spawns, or define an `outputSchema`.
- 9245fdc: codemode now writes a runscope orchestration ledger into the parent session. Every `spawn` and `runWorkflow` lifecycle event — `spawn_start`, `spawn_end`, `stage_start`, `stage_end`, `gate_result` — is appended as a typed custom entry (`customType: 'codemode-runscope'`) via `pi.appendEntry`, each carrying `{ runId, spanId, parentSpanId, kind, ts }`. Custom entries persist to the session JSONL without entering LLM context. Stage `parentSpanId` is derived from `needs` edges so the trace tree mirrors the workflow DAG; spawns inside a workflow are parented to their stage via `AsyncLocalStorage`. Dependency-free — no OpenTelemetry.

### Patch Changes

- 6172976: Add a "Recipes" section to the codemode README with the Adversarial Gauntlet recipe: a `sharesTree` builder stage with a synchronous critic gate over the real `git diff HEAD` (revise loop, `maxGateAttempts: 3`) plus an independent downstream critic stage over the captured `treeDiffs`. Docs-only; no runtime change.
- Updated dependencies [00958ee]
- Updated dependencies [1f032e3]
- Updated dependencies [00958ee]
- Updated dependencies [efef393]
  - @nicknisi/pi-shared@0.3.0

## 0.1.0

### Minor Changes

- aa583e4: The `codemode` tool gains a third injected binding: `runWorkflow(spec, opts?)` — the shared declarative workflow engine (needs/foreach/gates/retries, sharesTree tree-diff handoff, control artifacts + resume), bound to the codemode runtime with the tool's abort signals threaded into every stage spawn.
- aa583e4: New package: codemode rebuilt on the first-party subagent platform. The `codemode` tool executes model-written TypeScript in-process (via bundle-require) with an injected `spawn` binding over the shared in-process runtime — compositional orchestration (Promise.all fan-out, pipelines, map/reduce) with typed SpawnResults, bounded results/logs, timeout with child abort, and no pi-subagents dependency.
- 29eaae8: TUI surfaces for the platform: dispatch gets live per-task progress (renderCall/renderResult with council-style status trees) plus a background-runs widget; `/fleet` is now an interactive overlay with drill-down run details (text fallback when headless); intercom deliveries render as styled peer-mail cards with an aligned `/intercom` listing; codemode gets renderCall/renderResult with collapsed output, log tree, and error states.

### Patch Changes

- Updated dependencies [cacb4cc]
- Updated dependencies [121a19d]
- Updated dependencies [c60bd34]
- Updated dependencies [0aabf31]
- Updated dependencies [0aabf31]
- Updated dependencies [cacb4cc]
- Updated dependencies [73c772e]
  - @nicknisi/pi-shared@0.2.0
