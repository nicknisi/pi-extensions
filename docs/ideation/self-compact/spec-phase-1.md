# Implementation Spec: Self-Compaction, Phase 1

**Contract**: ./contract.md
**Phase**: Durable self-compaction lifecycle
**Risk**: High
**Estimated effort**: L

## Technical Approach

Build one standalone `@nicknisi/pi-self-compact` package. The public extension entry is `extensions/self-compact/self-compact.ts`; a root `index.ts` re-exports it for the existing repository build. Use Pi's public extension API, its session custom entries, and its exported compaction function rather than a new compaction engine, scheduler, database, or another extension. The only tool is `self_compact({ note_to_self: string })`.

The difficult part is lifecycle correctness, not parsing. Start with a deterministic provider driving **real Pi** and make a failing handoff test before implementing the coordinator. Pin the tested runtime to Pi 0.86.1 or newer: the root development dependencies are currently 0.84.0 and lack some required APIs. Keep runtime Pi dependencies as peers. Establish matching package-local test/type dependencies without upgrading unrelated root dependencies; verify actual imports resolve to the intended version rather than assuming a global CLI version also changes Vitest imports. Do not suppress incompatible types with blanket `any` or error ignores.

Use a small persisted handoff state and explicit transitions. Persist the original note and active-tool snapshot before acknowledging a valid handoff; return a terminating tool result; compact only after `agent_settled` and a fresh idle check; deliver the unchanged note separately from the summary and resume only unfinished work. Failure/cancellation remains locked and requires explicit retry. Ordinary reload must not replay a delivered handoff. Exactly-once external effects across arbitrary process crashes are explicitly not promised.

## Decisions Considered and Rejected

- Token defaults are soft 225k, warning 250k, buffer 20k. Rejected percentage defaults; 20%/50%/10% is a test fixture (implemented in phase 2).
- Root README, this project's changeset, and necessary lockfile updates are the only write-boundary exceptions. Rejected stopping at planning with an absolute two-directory boundary.
- Reject incompatible window settings; never silently scale defaults. Only warning plus buffer is capped at 90%.
- Preserve the note-only interface and honor completed work. Rejected a structured completion field and an exactly-once task executor.
- Successful built-in `/compact` may discharge a pending handoff. Rejected requiring a second compaction after successful manual recovery.
- Pause after compaction errors/cancellation; preserve note and lock rather than creating an automatic retry scheduler.
- Include one print-mode and one JSON-mode survival test because autonomous sessions must finish without a human keeping the process alive; do not multiply the entire suite by every mode.
- Require Pi >=0.86.1 with matching local verification dependencies, not a repo-wide runtime upgrade.
- Reuse Pi's compaction algorithm with a narrowly scoped system-message override rather than rewriting split-turn and file-tracking logic.
- Critic revision: use a pre-build boundary snapshot and root re-export/package-local build, because unit tests alone cannot prove preservation and the existing root build requires flat roots plus `dist` exports.

## Working Boundaries

- Write implementation, tests, temporary test fixtures, and verification evidence only under `packages/self-compact/`. Plan/run artifacts belong under `docs/ideation/self-compact/`.
- Only external exceptions: `README.md`, `pnpm-lock.yaml` if necessary, and this project's generated `.changeset/*.md` file. Do not edit root build scripts, tsconfig, workspace settings, root dependency versions, global Pi config, or any other extension.
- Existing user edits in `packages/codemode/index.ts` and `packages/workflows/index.ts` must remain byte-for-byte unchanged and unstaged. User explicitly accepted carrying them onto `ideation/self-compact`.
- `docs/` is ignored by local `.git/info/exclude`. Explicitly force-add only this project's approved plan artifacts if they are committed. Never change that exclude file or add unrelated docs.
- Avoid broad `pnpm format` or root `pnpm build`: they write unrelated deliverables. Dependency installation must suppress the root prepare script (`--ignore-scripts`), followed by a package-local build.
- Baseline: repository `pnpm typecheck` and `pnpm lint` passed during planning. Root `pnpm format:check` already fails on 31 unrelated `.pi/artifacts/` files. Report, do not fix them.

## Feedback Strategy

**Inner-loop command**: `pnpm exec vitest run packages/self-compact/lifecycle.test.ts`

**Playground**: Vitest plus one package-local deterministic provider fixture running actual Pi SDK/CLI sessions with persistent session files in disposable test directories.

**Why**: Fast handler tests isolate transitions, while real lifecycle tests catch batch semantics, hook ordering, and print-mode shutdown that mocks cannot prove. Keep ordinary unit loops in seconds; integration tests have explicit bounded timeouts.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `packages/self-compact/package.json` | Standalone manifest, peers, local verification dependencies, build/typecheck scripts |
| `packages/self-compact/index.ts` | Re-export nested extension for compiled entry |
| `packages/self-compact/tsconfig.json` | Package-local typecheck scope using repository compiler policy |
| `packages/self-compact/tsconfig.build.json` | Package-local emit mirroring root build roots and options |
| `packages/self-compact/extensions/self-compact/self-compact.ts` | Factory, note tool, persistence, lock, idle/compaction/continuation lifecycle |
| `packages/self-compact/extensions/self-compact/prompts.ts` | Summary override using Pi's compactor and actual transcript system-message API |
| `packages/self-compact/.pi/self-compact/USER_PROMPT_COMPACTION_MESSAGE.md` | Editable default summary system instruction |
| `packages/self-compact/lifecycle.test.ts` | Note validation and state/lock unit tests |
| `packages/self-compact/prompts.test.ts` | Actual summarizer context and precedence checks |
| `packages/self-compact/integration.test.ts` | Real-Pi deterministic lifecycle and recovery scenarios |
| `packages/self-compact/verify/fixture-provider.ts` | Minimal scripted provider for tests only, not production runtime |
| `packages/self-compact/verify/cli-runner.ts` | Actual print/JSON subprocess driver, added during implementation |
| `packages/self-compact/verify/cli-harness.ts` | Test-only CLI provider registration, added during implementation |
| `packages/self-compact/verify/boundary.mjs` | Capture/check approved path boundary with content hashes |
| `packages/self-compact/verify/results/boundary-baseline.json` | Pre-implementation snapshot, local evidence, not a committed machine-specific fixture |
| `packages/self-compact/.gitignore` | Ignore local evidence, sessions, generated result and build output as appropriate |

### Modified Files

| File Path | Changes |
| --- | --- |
| `pnpm-lock.yaml` | Only resolution necessary for this package's declared test/peer setup |

No deletions. Later phases may extend these files; keep helpers small, with no generic state-machine framework. A new top-level `*.test.ts` participates in the root build, so ensure compilation works under both configurations.

## Implementation Details

### 1. Boundary and package setup

**Patterns to follow**: `packages/stash/package.json`, `scripts/build.ts`, `tsconfig.json`.

1. Before implementation edits, capture `git status`, baseline HEAD, and content hashes of existing tracked/untracked nonignored files outside the allowlist, including both dirty user files. Capture first into the package's local evidence directory; then implement the small reusable `boundary.mjs capture|check` utility to read that format. Do not overwrite the original baseline on later phases/retries.
2. Check detects new/deleted/modified nonallowed files and modifications to existing unrelated work; report discrepancies rather than restoring files. Enumerate Git-visible files to avoid hashing dependency caches. Missing baseline is a failure. Scope the changeset exception to this package's generated file, not the whole directory.
3. Create conventional package metadata and `pi.extensions: ["./extensions/self-compact/self-compact.ts"]`. `exports["."].default` points to emitted `dist/index.js`, `types` to `dist/index.d.ts`; package `files` explicitly includes source entry/helper directories, `index.ts`, `dist`, and `.pi/self-compact`.
4. Make `index.ts` import/re-export the nested factory. This pulls nested sources into the root build without editing `scripts/build.ts`.
5. Build/typecheck only this package. No new third-party runtime dependencies beyond required Pi peers and its normal schema dependency. No `@nicknisi/pi-shared` dependency is necessary.

Config and re-export files require compiler checks rather than custom feedback loops. Boundary utility loop: create an isolated temporary Git fixture, modify permitted/unpermitted paths and a pre-existing dirty file, and assert `capture`/`check` fail appropriately; include this in `lifecycle.test.ts` or the later package suite.

### 2. Note validation and handoff reservation

**Patterns to follow**: Pi `examples/extensions/structured-output.ts`; `packages/ast-grep/index.test.ts` for capturing tool definitions.

- Schema requires a string note; explicit runtime checks reject `trim().length === 0` and `length > 24000`. Validate without trimming/reformatting the saved content. Use JS string-length semantics consistently in boundary tests and docs.
- Persistence failure must not report successful handoff, discard the previous pending note, or release a lock. Keep the original note immutable across retries; reject attempts to replace an existing pending handoff with different text until it completes.
- Capture the prior active-tool selection once, never overwrite it with the already restricted selection on retry/reload. Filter restored names through currently registered tools; never enable all tools merely because compaction succeeded.
- Use both active-tool restriction and a `tool_call` execution gate; hiding a tool alone is insufficient.
- Mixed batches matter: Pi preflights all sibling calls before concurrently executing them, and termination requires every finalized result to terminate. Inspect the current assistant message at preflight to reserve a validated handoff before ordinary siblings execute, regardless of source order. Block siblings with terminating results while the handoff is pending; ensure errors/duplicate self calls cannot strand the run. Do not claim retroactive cancellation of previously running external work.
- Tool guidance should ask for a sole `self_compact` call, but correctness tests must not rely solely on compliance. If native termination cannot satisfy an edge case, find the smallest public-API stop at the completed batch boundary and verify its observable behavior; do not patch Pi internals.

**Feedback loop**: Start the `note validation` describe block with blank, whitespace, 24,000, 24,001, preserved leading/trailing whitespace, multiline Unicode, persistence-error, and duplicate/retry cases. Run `pnpm exec vitest run packages/self-compact/lifecycle.test.ts -t 'note validation'`.

### 3. Idle compaction and exact continuation

**Pattern to follow**: Pi `agent_settled`, `ctx.compact`, `pi.appendEntry`, `pi.sendMessage`; inspect installed `dist/core/agent-session.js` and `dist/modes/print-mode.js` before coding.

A minimal persisted state can contain cycle ID, phase (`pending`, `compacting`, `failed`, `ready-to-deliver`, `delivered`), original note, original active tools, completed cycle count, and last error. Use named custom entries on the current branch. Do not store a separate handoff database or filesystem note file.

1. Save valid note, lock tools, and let the current tool batch finish cleanly.
2. At `agent_settled`, check that the same branch/session/cycle is still current and `ctx.isIdle()` is true before requesting self-compaction. Do not compact within the tool's `execute` or assume `agent_end` means idle.
3. Persist success from `session_compact`, but do not launch continuation while manual compaction is still active. Its event fires before manual state is cleared; initiating `onComplete` is after clearing. Manual `/compact` recovery must also eventually deliver once idle without requiring another user prompt.
4. Restore only the saved active selection after successful compaction. Send a custom continuation message containing the original note verbatim, with instructions in a separate block to perform only unfinished next actions and report completion without restarting the original task. The note is not the summary system prompt.
5. Record delivery with cycle IDs and reconcile against persisted continuation messages on startup/reload. Use current branch entries, not all branches indiscriminately. Standard reload of a completed cycle does not start another turn.
6. Await lifecycle work sufficiently that `pi -p`/JSON cannot dispose the process before compaction and continuation complete. Exercise actual CLI process completion. Avoid deadlocking by awaiting an operation whose completion depends on the event handler returning; inspect actual installed sequencing.
7. Pi's automatic threshold/overflow compaction remains its own behavior and must not create duplicate handoff delivery or release a failed lock prematurely. Self-requested compaction obeys idle-only scheduling; successful automatic/manual compaction of a pending note is reconciled by the same cycle coordinator. No global compaction setting is changed.

**Feedback loop**: A deterministic provider first requests self_compact, then verifies returned note and tool availability, writes a result with the real write tool, and stops. Add mixed-batch both orders, queued messages, successful manual recovery, and exactly one print/JSON survival case. Command: `pnpm exec vitest run packages/self-compact/integration.test.ts -t 'handoff lifecycle'`.

### 4. Summary system-message replacement

**Pattern to follow**: Pi `examples/extensions/custom-compaction.ts` and exported `compact()` types. Do not copy that example's silent fallback on failure.

- Load the package-relative `USER_PROMPT_COMPACTION_MESSAGE.md`, independent of the launch cwd. Phase 2 adds literal `--compact-prompt` precedence.
- Prefer exported `compact(preparation, model, ..., streamFn, ...)` with a small stream callback that changes the actual normalized transcript system instruction before calling `ctx.modelRegistry.streamSimple`. Pi 0.86 uses transcript messages; setting an obsolete `systemPrompt` field does not prove replacement.
- Preserve prepared cut points, previous summary, file operations, split-turn behavior, custom manual focus instructions, usage accounting, abort signal, and fresh summarization routing semantics. Override both history and split-turn prefix requests.
- Catch summary failures explicitly and return `{ cancel: true }` after recording failure. Throwing out of the event handler can be swallowed by Pi and accidentally fall back to its default compactor. Empty/truncated/error responses must not count as success.
- Read editable files per use (or with a clear reload policy tested in phase 2), not from a global config directory. Never create files in arbitrary caller projects.

**Feedback loop**: The deterministic provider captures summary request messages. Assert exact leading system instructions for normal and split-turn cases, preserved manual focus, and error/abort retention. Command: `pnpm exec vitest run packages/self-compact/prompts.test.ts packages/self-compact/integration.test.ts -t 'prompt overrides'`.

### 5. Recovery

- On failure/cancellation, persist note, tool snapshot, error, and failed phase. Keep other agent tools locked; `agent_settled` must not start an unbounded retry loop.
- On reload/resume, reconstruct state from the active branch. An interrupted pending/compacting cycle remains recoverable and locked. A recorded successful compaction with undelivered note can complete delivery; a delivered cycle stays quiet.
- Phase 2's `/self-compact-now` includes the exact pending note and directs the model to retry `self_compact`; it never fabricates a new note or bypasses the tool. This phase can test that retry through actual tool calls directly.
- Successful native manual compaction discharges pending handoff state; never register a command named `compact`.
- Session switching/shutdown must prevent late callbacks touching a new session. Remove/ignore obsolete work using cycle/session identity and cancellation; no broad task scheduler.

**Feedback loop**: Inject summary error and abort, reload a persistent session, attempt ordinary tools, retry with unchanged note, inspect restored tools and one delivery, then reload again. Also test branch navigation does not recover another branch's handoff. Command: `pnpm exec vitest run packages/self-compact/integration.test.ts -t 'recovery'`.

## Testing Requirements

| Test file | Required coverage |
| --- | --- |
| `lifecycle.test.ts` | Validation, persistence failure, original tool snapshot, lock/retry transitions, boundary helper negative cases |
| `prompts.test.ts` | Summary content extraction/replacement, blank/error/abort failure behavior |
| `integration.test.ts` | Actual Pi lifecycle, mixed batches, queued messages, manual/automatic interaction, persistent reload, print/JSON survival |

Tests must fail when required cases are skipped or when a test-name filter matches nothing; use stable describe names listed above. Deterministic provider registration is test-only, with assertions on actual provider requests and real tool side effects. The test fixture must not fake the extension's compaction events. It may control provider responses, usage counts, and explicit compaction failure signals.

## Failure Modes

| Component | Failure | Trigger | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| Tool gate | Sibling side effect escapes | Parallel batch preflight precedes execute | Work occurs after intended checkpoint | Reserve validated handoff during batch-aware preflight; test both call orders |
| Lifecycle | Deadlock/early exit | Await wrong hook or detached print callback | No continuation | Real CLI tests, explicit timeouts, actual event-order assertions |
| Persistence | Note reported saved but write failed | Permission/storage failure | Lost handoff | Treat persistence failure as failure, retain in-memory lock and error, test |
| Recovery | Wrong branch or duplicate delivery | Reload/navigation or stale callback | Repeated work | Branch-local recovery, cycle IDs, persisted delivery reconciliation |
| Summary | Override ignored | Legacy context field or swallowed hook error | Wrong prompt or false success | Capture real requests, explicitly cancel on failure |
| Environment | Tests accidentally use 0.84 | Root resolution wins | False confidence/incompatible types | Assert runtime version and isolate matching local test resolution |
| Packaging | Nested source not emitted | Root build uses flat roots | Broken npm export | Root index re-export and package-local emit verification |

## Validation Commands

```bash
pnpm exec vitest run packages/self-compact/lifecycle.test.ts packages/self-compact/prompts.test.ts packages/self-compact/integration.test.ts
pnpm --filter @nicknisi/pi-self-compact typecheck
pnpm --filter @nicknisi/pi-self-compact build
pnpm exec oxlint packages/self-compact
pnpm exec oxfmt --check packages/self-compact
node packages/self-compact/verify/boundary.mjs check
```

Format only owned source files if needed. Run repository-wide read-only typecheck/lint checks to detect regressions; report unrelated failures without editing them. Final contract-level tests for thresholds/UI/live acceptance are later-phase deliverables, not expected to pass in this phase.

## Rollout and Commit

No installation into the user's global Pi config, no npm publish, no core patch. Commit only verified phase-owned files on `ideation/self-compact`. Use a conventional commit and include `docs/ideation/self-compact/spec-phase-1.md` verbatim in its body. Do not stage pre-existing edits. Keep evidence under the package; commit implementation and portable fixtures, not authentication/session logs. Phase 3 supplies final documentation and release changeset.
