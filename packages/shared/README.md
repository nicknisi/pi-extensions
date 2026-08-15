# @nicknisi/pi-shared

Shared helper library for the extensions in this monorepo. It is not a pi extension itself — it exports no default extension entry, adds no commands, tools, keybindings, widgets, or events, and installing it into pi directly does nothing. Other packages depend on it via `"@nicknisi/pi-shared": "workspace:*"` and import from it like any library.

It exists to centralize things that several extensions were duplicating: one-off LLM calls on pi-ai's modern provider API (no `/compat` imports), a set of TUI utilities (gradient text, renderable-tree surgery, two-column layout, escape-sequence sanitization, render dispatch) plus a composable searchable select component, and an in-process subagent runtime for spawning focused child agent sessions.

## Exports

`index.ts` re-exports everything from `llm.ts`, `tui-utils.ts`, `searchable-select-list.ts`, and `subagents.ts`.

### LLM (`llm.ts`)

```ts
import { getModelProvider } from '@nicknisi/pi-shared';
```

`getModelProvider(ctx, model)` resolves the composed runtime provider for a model via `ctx.modelRegistry.getProvider(model.provider)`. Unlike compat's global API dispatch, this honors `models.json` overrides and extension-registered providers. Throws `No provider registered for <provider>` if unregistered.

`ctx` only needs a `modelRegistry` (`Pick<ExtensionContext, "modelRegistry">`), so non-extension callers can pass a narrower object.

Migration cheat sheet from the compat API (documented in the source header):

```ts
// compat complete(model, ctx, opts)
getModelProvider(ctx, model).stream(model, ctx, opts).result();

// compat streamSimple(model, ctx, opts)
getModelProvider(ctx, model).streamSimple(model, ctx, opts);
```

Auth stays explicit: pass `apiKey`/`headers` from `ctx.modelRegistry.getApiKeyAndHeaders(model)` in the stream options.

### TUI utilities (`tui-utils.ts`)

```ts
import {
  columns,
  formatDirectory,
  gradientText,
  hideLabeledSection,
  sanitizeTerminalLabel,
  // ...
} from '@nicknisi/pi-shared';
```

Six self-contained patterns, adapted from a pi dashboard extension:

| Export                                             | What it does                                                                                                                                                                                                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gradientText(text, phase, palette?)`              | Per-character truecolor gradient. `phase` shifts the gradient (use `rowIndex * k` to stagger multi-line art). Spaces pass through uncolored.                                                                                                                                 |
| `sampleGradient(position, palette?)`               | Sample a wrapping gradient at `position` (0..1, wraps modulo 1); adjacent palette stops are linearly interpolated.                                                                                                                                                           |
| `DEFAULT_PALETTE`, `RESET`                         | Default blue-leaning 6-stop RGB palette; ANSI reset code.                                                                                                                                                                                                                    |
| `hideLabeledSection(root, label)`                  | Walk a renderable tree, find the first child whose first non-empty rendered line equals `label`, splice it out (plus one trailing blank-line sibling), and `invalidate()` the root. Returns `true` if removed. Original use: stripping pi's auto-injected `[Themes]` widget. |
| `scheduleHideLabeledSection(root, label, delays?)` | Progressive-poll removal at `[0, 50, 250, 1000]` ms for asynchronously injected nodes; calls `root.requestRender(true)` on success. Returns timers.                                                                                                                          |
| `clearHideTimers(timers)`                          | Teardown for the above.                                                                                                                                                                                                                                                      |
| `columns(left, right, width)`                      | Two-column line layout. Pads the gap when both sides fit; otherwise shrinks left to ~45% and right to the remainder with a minimum 1-space gap, truncating via pi-tui's `truncateToWidth`.                                                                                   |
| `sanitizeTerminalLabel(text)`                      | Strip OSC, CSI, other escape sequences, and C0/C1 control chars from user-controllable strings before rendering (prevents escape injection and layout breakage).                                                                                                             |
| `formatDirectory(cwd)`                             | Collapse `$HOME` to `~` for display, then sanitize.                                                                                                                                                                                                                          |
| `renderedText(node, width = 200)`                  | Render a node to a throwaway 200-wide buffer and strip ANSI — introspect a component whose API only exposes `render(width)`. Returns `""` if `render` throws.                                                                                                                |
| `createRenderDispatcher()`                         | Reassignable render thunk so event sources can trigger redraws without knowing which surface is bound. `bind(tui)` points `requestRender()` at `tui.requestRender()`; `unbind()` clears it.                                                                                  |

Shared structural types: `RenderableNode` (`children?`, `invalidate()`, `render(width)`), `RequestRenderable` (adds `requestRender(force?)`), `RenderDispatcher`. These are subsets of pi's own `RenderableNode` and are structurally compatible with `@earendil-works/pi-coding-agent` components.

### Searchable select (`searchable-select-list.ts`)

```ts
import { SearchableSelectList } from '@nicknisi/pi-shared';
```

A pi-tui `Component` composing an `Input` above a `SelectList`. pi-tui removed `SelectList.searchable`; this is the manual filtering pattern pi's own model/theme selectors use. `handleInput` routes the `tui.select.up` / `tui.select.down` / `tui.select.confirm` / `tui.select.cancel` keybindings to the list and everything else to the input, whose value drives `selectList.setFilter()`.

```ts
const list = new SearchableSelectList(items, maxVisible, theme);
list.onSelect = (item) => {
  /* ... */
};
list.onCancel = () => {
  /* ... */
};
// mount into an overlay/dialog; render(width) and handleInput(keyData) are the Component contract
```

`selectList` is exposed for direct list manipulation. Use `setItems(items)` to refresh dynamic rows while preserving the current filter and selected value.

### Subagents (`subagents.ts`)

```ts
import { createSubagentRuntime } from '@nicknisi/pi-shared';
```

In-process subagent runtime: spawn focused child agent sessions through pi's SDK (`createAgentSession`) — no subprocesses, no dependency on pi-subagents. Because pi's extension loader aliases `@earendil-works/*` imports to the running host, children are always version-matched to the pi that loaded the extension.

```ts
const subagents = createSubagentRuntime({ namespace: 'my-extension' });

const result = await subagents.spawn({
  model: 'anthropic/claude-haiku-4-5', // optional; pi default resolution when omitted
  prompt: 'Review src/auth.ts for …',
  tools: ['read', 'grep'], // allowlist; [] = none; omit = pi defaults
  systemPrompt: 'You are a security reviewer.', // appended to pi's default prompt
  outputSchema: MySchema, // optional TypeBox schema for the final message
  onUsage: (usage) => updateDisplay(usage.totalTokens), // cumulative after each response
  onSupervisorRequest: async ({ message }) => 'supervisor reply',
});

if (result.ok) {
  result.text; // final assistant message (last message only, never a concatenation)
  result.data; // parsed + validated output, when outputSchema was given
  result.usage; // { inputTokens, outputTokens, totalTokens, cost? }
} else {
  result.kind; // 'crashed' | 'empty' | 'schema_invalid' | 'aborted'
}
```

Design rules baked in:

- **Hermetic children.** No user extensions, skills, prompt templates, themes, or context files load into a child unless explicitly requested (`extensionPaths`, `skillPaths`, `includeContextFiles`). A configured pi-subagents install never leaks in.
- **Tool scoping by construction.** A child gets exactly the allowlisted built-ins plus the supervisor tool when requested. No spawn capability exists as a tool, so children cannot spawn children.
- **Never rejects.** `spawn()` resolves a discriminated union. `schema_invalid` (unparseable/invalid JSON) is deliberately distinct from a schema-valid answer whose _content_ reports failure — engines with retry loops key off that distinction.
- **The supervisor channel is a closure.** `onSupervisorRequest` registers a `<namespace>_contact_supervisor` tool in the child wired straight to the parent handler — no filesystem protocol, no polling.
- **Ecosystem recursion guard, honored not namespaced.** Spawning is refused when `PI_SUBAGENT_DEPTH` / `PI_SUBAGENT_CHILD` are set (i.e. your extension is itself running inside a pi-subagents child).
- **Live usage.** `onUsage` receives cumulative input, output, total-token, and optional cost data after each completed assistant response. The current total is also mirrored onto the live `RunRecord`, so registry-backed views can display token burn before the run settles. Observer errors never fail the child.
- **Run registry + background.** `listRuns()` returns recent runs (newest first, capped at 200); `activeCount()` reports in-flight spawns. `spawnDetached()` launches without awaiting, returning `{ runId, done }` for background work. Concurrency is capped per runtime (`maxConcurrent`, default 4) AND process-wide per module instance (`GLOBAL_MAX_CHILDREN = 8`), which covers the realistic stacking case — a codemode workflow nesting further spawns. pi's loader gives every extension its own evaluated copy of this module, so a _cross-extension_ limiter is impossible without a file lock (overkill) — size each runtime accordingly.
- **Worktree isolation.** `spawn({ worktree: true })` runs the child in a detached git worktree (`~/.pi/agent/subagent-worktrees/<runId>`, from HEAD). On settle, the full delta — including untracked files, via `git add -A` + `git diff --cached HEAD` — is captured untruncated to `<runId>.patch` beside the run artifact, and `RunRecord.worktree` records `{ path, repoRoot, patchPath, changedFiles }`. Merge-back is the caller's decision (central integration). Fails fast with `kind: 'crashed'` when cwd isn't in a git repo.
- **Persisted run artifacts.** With `artifactsDir` on `createSubagentRuntime`, every run persists its record (status, timing, usage, bounded output, last-20-events transcript, worktree handoff, and `ownerSession` when supplied) to `<dir>/<namespace>/<runId>.json` on each status transition and usage update — the cross-extension fleet view, since the on-disk root is the only layer pi's module isolation leaves shared. `readRunArtifacts(rootDir)` reads records across namespaces. `sweepRunArtifactsOnce(rootDir)` (call at extension init) garbage-collects records older than 7 days — with their `.patch` siblings and worktrees — and reaps ghost `running`/`queued` records whose `hostPid` belongs to a dead process (marked `aborted`, **and their worktrees removed**, so the fleet shows the truth after a host crash without leaking detached worktrees).
- **Standard pi session mirror (dual-write).** `spawn({ ownerSession })` records ownership on `RunRecord.ownerSession` without enabling a mirror. `spawn({ parentSession })` uses the same path as the owner and ALSO persists the run as a standard pi session JSONL via the real `SessionManager` into the default sessions dir, with the header's `parentSession` linked to the owning session — so runs are inspectable with pi's native `/resume`, `/tree`, and `--fork`. The child mirror path is recorded separately on `RunRecord.sessionFile`. Additive: the bespoke `.json` artifact is still written and is what `readRunArtifacts`/fleet read. Opt-in: when `parentSession` is omitted, no mirror is written (so other shared-runtime consumers are unaffected). `SessionManager` creates the JSONL lazily on the first assistant message, so a run that produced no assistant turn leaves no file and `sessionFile` is `undefined`.
- **Timeout/abort/budgets.** `timeoutMs` (default 15 min, `0` disables) and `signal` both map to `session.abort()`; `maxTurns` / `maxToolCalls` abort the child when exceeded. All three produce `kind: 'aborted'` with a reason-specific error.

Also exported: `resolveContainedAgentResource(kind, name, leaf)` — containment-checked resolution of a bare name under the agent dir (`~/.pi/agent/extensions/<name>/<leaf>` etc.) for untrusted config input; returns `null` for anything with path separators or `..`. And `sweepRunArtifacts(rootDir, { now?, retentionMs? })` for direct GC control (returns `{ deleted, reaped }`).

Non-goal: crash isolation — children share the parent's event loop and memory (a pathological child can hurt the host session). Orchestration lives in `workflow.ts` (below).

### Workflow engine (`workflow.ts`)

```ts
import { runWorkflow } from '@nicknisi/pi-shared';
```

Declarative multi-stage workflows over a `SubagentRuntime`. A workflow is a list of stages with explicit (`needs`) or implicit (linear chain — each stage depends on the previously declared one) dependencies; the engine schedules them over the runtime and resolves a `WorkflowResult` (never rejects).

```ts
const result = await runWorkflow(
  {
    name: 'review-pipeline',
    concurrency: 4, // scheduler cap; default 4
    tokenBudget: 500_000, // stop starting new stages once exceeded
    stages: [
      { id: 'scout', needs: [], agent: 'scout', prompt: 'Map the auth module…' },
      {
        id: 'reviewers',
        needs: ['scout'],
        foreach: ['correctness', 'tests', 'simplicity'], // one spawn per item
        prompt: (ctx, lens) => `Review as ${lens}. Context: ${(ctx.results.scout as any)?.output}`,
        gate: (outcome) => (outcome.output.length > 200 ? true : { revise: 'Too thin — be specific.' }),
      },
      {
        id: 'fix',
        needs: ['reviewers'],
        sharesTree: true, // declares it edits the shared working tree
        tools: ['read', 'edit', 'bash'],
        prompt: (ctx) => `Apply the feedback. Diff so far:\n${ctx.treeDiffs['fix'] ?? ''}`,
      },
    ],
  },
  runtime,
  { cwd: process.cwd(), resumeFrom: previousRunDir },
);
```

Full stage schema: `{ id, agent?, prompt (string | (ctx, item?, index?) => string), model?, tools?, systemPrompt?, outputSchema?, needs?, sharesTree?, worktree?, foreach?, gate?, maxGateAttempts?, retries?, maxTurns?, maxToolCalls?, timeoutMs? }`. `sharesTree` and `worktree` are mutually exclusive (validated up front): sharesTree = edit the caller's tree with resource exclusion; worktree = isolated worktree per spawn with patch handoff. `resumeFrom` is content-addressed: each stage artifact carries a per-stage key (sha256 over the stage's resolved prompt, model, tools, systemPrompt, outputSchema, needs, retries, maxTurns, maxToolCalls, timeoutMs, foreach shape, hasGate, sharesTree, worktree — function-valued prompts hash via `.toString()`, so edits to prompt closures ARE covered — plus the content keys of its upstream `needs` stages, Merkle-style), and `status.json` carries a `stageKeys` map plus a whole-spec `specHash` (back-compat). Resume replays a previously-ok stage ONLY if its key still matches — an unchanged prefix replays free; a changed stage re-runs itself and (via upstream chaining) everything downstream. Old runDirs without `stageKeys` fall back to the whole-spec `specHash`. `prompt`/`gate` receive a `StageContext`: `results` (typed outcomes of completed stages), `treeDiffs`, `cwd`, `runDir`. `tools` defaults to read-only (`['read', 'grep', 'find', 'ls']`) when omitted — a stage that edits files or runs bash must pass `tools` explicitly.

Semantics:

- **Two-channel handoff.** (1) Typed results flow via `ctx.results`. (2) When a `sharesTree` stage completes ok in a git repo, its bounded (64KB) `git diff HEAD` snapshot flows to dependents via `ctx.treeDiffs[stageId]`.
- **Resource exclusion.** A `sharesTree` stage never runs concurrently with ANY other stage: while one is queued the scheduler pauses new starts and waits for the running set to drain. Non-tree stages overlap freely up to `concurrency`. Conservative by design — declare `sharesTree` on anything that reads or writes the working tree.
- **Failure containment.** A failed dependency transitively skips dependents (`kind: 'skipped'`). An exhausted `tokenBudget` skips unstarted stages (`kind: 'budget_exceeded'`). Workflow `ok` = every stage ok.
- **`foreach`.** Static array or `{ from: stageId, pick? }` resolving items from a dependency's ok outcome (`pick` defaults to the outcome's `data`). Each item is an independent spawn counting individually against concurrency; the stage outcome's `output` is the JSON array of per-item outputs (`data` is the array of validated per-item data when `outputSchema` is set). One failed item fails the stage.
- **`gate` — the vacuous-pass defense.** Runs on each ok outcome; `{ revise: feedback }` re-spawns with the feedback appended (up to `maxGateAttempts`, default 2), exhaustion or a gate exception fails the stage as `gate_failed`. The engine treats runtime `empty` outcomes as failures; use gates to enforce real content contracts ("PASS with no findings" is not a pass).
- **`retries`.** Re-spawns on `crashed`/`empty` only — `aborted` and `schema_invalid` fail immediately.
- **Control artifacts + resume.** Every run writes `status.json` (with a `stageKeys` map + whole-spec `specHash`) and `stages/<id>.json` (outcome + treeDiff + per-stage `contentKey`) under its runDir — default `<agentDir>/workflow-runs/<name>-<timestamp>` — enabling `resumeFrom` to replay previously-ok stages whose content key still matches and reload their outcomes (and tree diffs) from disk. A `resume_summary` event (`onProgress`) reports how many stages were replayed vs. re-run.

The engine depends only on the `SubagentRuntime` **type**, so tests drive it with a hand-rolled fake — see `workflow.test.ts` (run: `pnpm test`).

## Usage

Consumers in this monorepo add the workspace dependency:

```json
{
  "dependencies": {
    "@nicknisi/pi-shared": "workspace:*"
  }
}
```

and import individual functions as shown above. Known consumers: `answer`, `btw`, `handoff`, `header`, `llm-council`, `session-name`, `statusline`.

## Configuration

None. No config files, no options, no environment variables.

## Install

Not intended for direct installation — it registers nothing with pi. It is pulled in automatically as a workspace dependency of the extensions that use it. If you did run it:

```bash
pi install /Users/nicknisi/Developer/pi-extensions/packages/shared
```

pi would load the package and find no extension entry point.

## Dependencies

Peer dependencies (all `*`, provided by the pi runtime):

- `@earendil-works/pi-ai` — types (`Api`, `Model`, `Provider`) for `getModelProvider`.
- `@earendil-works/pi-coding-agent` — `ExtensionContext` type; the `RenderableNode` shape targets its component tree.
- `@earendil-works/pi-tui` — `truncateToWidth`, `visibleWidth` (layout), and `Container`, `Input`, `SelectList`, `getKeybindings` (searchable select).

Runtime npm dependencies:

- `typebox` — `outputSchema` validation in `subagents.ts` (`Value.Check`/`Clean`/`Convert`/`Errors`). At pi-load time the import is aliased to pi's bundled copy; the declared dependency covers non-pi consumers of the published package.

## Caveats

- `getModelProvider` depends on pi-ai's provider-owns-streaming architecture and `ModelRegistry.getProvider()` returning the composed runtime provider. Both are current pi internals and could change across pi versions; the compat API this replaces is the canary — if pi-ai restructures provider resolution again, this needs to move with it.
- `hideLabeledSection` relies on rendering children to a throwaway buffer to compare visible text — it depends on `render(width)` being side-effect-free enough to call speculatively, and on target sections having a stable first visible line (pi's `[Themes]` widget label is a pi internal that could change).
- `scheduleHideLabeledSection` is a timing heuristic (`[0, 50, 250, 1000]` ms) for asynchronously injected nodes; a sufficiently slow injection can slip past the last poll.
- `SearchableSelectList` hardcodes the `tui.select.*` keybinding IDs from pi-tui. If those IDs are renamed, navigation silently stops routing.
- `package.json` `files` lists every shipped source plus `dist`; `pnpm pack`/publish produces a working tarball.
- The package is marked `private: true` and ships TypeScript sources (`exports: { ".": "./index.ts" }`); consumers must run in pi's TS-loading extension environment, not plain Node.
