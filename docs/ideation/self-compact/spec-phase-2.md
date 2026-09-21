# Implementation Spec: Self-Compaction, Phase 2

**Contract**: ./contract.md
**Phase**: Threshold controls and context UI
**Prerequisite**: Durable self-compaction lifecycle
**Risk**: Medium
**Estimated effort**: M

## Technical Approach

Extend phase 1's standalone package and lifecycle coordinator with four string flags, three threshold levels, editable guidance, a small context widget, and two slash commands. Use pure functions for threshold parsing/resolution and bar rendering. Keep orchestration in the existing extension factory; do not introduce a generic configuration framework, per-model settings database, timer service, or replacement footer.

The defaults are 225,000 tokens soft, 250,000 warning, and 20,000 additional tokens before hard enforcement. Percentage inputs always refer to the model's full context window, including buffer percentages. Hard means agent tools other than self_compact are blocked, not that compaction bypasses the required note. Soft and warning guidance never block ordinary tools. A manual /compact remains Pi's built-in escape hatch and honors the summary override through the existing hook.

## Decisions Considered and Rejected

- Use 225k/250k/20k-buffer defaults. Rejected 20%/50%/60% defaults; those percentages are an explicitly configured bar fixture.
- Reject incompatible model-window settings and explain valid flags. Rejected automatic scaling. Cap only warning plus buffer at 90% of the window.
- Keep the free-text note-only tool. Rejected a completion-state field; continuation resumes only unfinished work and delivered cycles are not routinely replayed.
- Successful built-in /compact finishes a pending handoff. Rejected an extra required compaction through the tool afterward.
- Failures remain locked with the note intact; explicit /self-compact-now retry rather than a background retry scheduler.
- Use a widget above the editor, not a footer replacement, so existing statusline extensions coexist.
- Prompts live under this package's .pi/self-compact, independent of caller cwd. No global config or caller-project file creation.
- Preserve the narrow write boundary, existing codemode/workflows edits, package-local verification dependencies, and root re-export/build arrangement established in phase 1.

## Working Boundaries

Implementation and evidence stay in `packages/self-compact/`; plan/run artifacts stay in `docs/ideation/self-compact/`. Only root README, necessary lockfile updates, and this project's generated changeset are permitted exceptions. No other extension, Pi core, root build config, or global Pi setting changes. Preserve the phase-1 boundary baseline without recapture. Existing `packages/codemode/index.ts` and `packages/workflows/index.ts` edits are user-owned and must remain unstaged and unchanged.

Use only package-local formatting/build commands. Root format:check already fails on 31 unrelated `.pi/artifacts/` files; do not fix them. Root typecheck/lint passed at planning time.

## Feedback Strategy

**Inner-loop command**: `pnpm exec vitest run packages/self-compact/config.test.ts packages/self-compact/bar.test.ts packages/self-compact/lifecycle.test.ts`

**Playground**: Pure Vitest tests, the phase-1 real-Pi fixture, and a scratch TUI session for the widget.

**Why**: Numeric behavior and exact bar strings are deterministic; actual event and RPC widget tests establish that the pure helpers are correctly connected to the real extension.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `packages/self-compact/extensions/self-compact/config.ts` | Parse and resolve threshold flags |
| `packages/self-compact/extensions/self-compact/bar.ts` | Pure 20-cell renderer and latest-applicable cache calculation |
| `packages/self-compact/.pi/self-compact/USER_PROMPT_SOFT_SELF_COMPACT.md` | Editable optional heads-up template |
| `packages/self-compact/.pi/self-compact/USER_PROMPT_WARNING_SELF_COMPACT.md` | Editable stern warning template |
| `packages/self-compact/config.test.ts` | Parsing, limits, launch variants, model changes |
| `packages/self-compact/bar.test.ts` | Exact marker/cached/free rendering |

### Modified Files

| File Path | Changes |
| --- | --- |
| `packages/self-compact/extensions/self-compact/self-compact.ts` | Register flags/commands, enforce thresholds, update widget |
| `packages/self-compact/extensions/self-compact/prompts.ts` | Guidance interpolation, literal summary override precedence |
| `packages/self-compact/.pi/self-compact/USER_PROMPT_COMPACTION_MESSAGE.md` | Refine summary guidance if required by integration evidence |
| `packages/self-compact/lifecycle.test.ts` | Threshold enforcement, model-change, notification and retry tests |
| `packages/self-compact/prompts.test.ts` | Guidance values, file loading, flag precedence |
| `packages/self-compact/integration.test.ts` | RPC widget, human commands, prompt override and threshold integration |
| `packages/self-compact/verify/fixture-provider.ts` | Only scripted scenarios needed for added integration coverage |
| `packages/self-compact/package.json` | Source/prompt inclusion and scripts only if needed |

No deletions. Reuse phase-1 persistence and compaction hooks rather than building a second lock or duplicate completion handler.

## Implementation Details

### 1. Four flags and deterministic resolution

Register string flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `compact-soft-at` | `225k` | Optional heads-up |
| `compact-at` | `250k` | Ask for note and self-compaction |
| `compact-buffer` | `20k` | Additional tokens or percentage points before tool enforcement |
| `compact-prompt` | absent | Literal replacement summary system instruction |

Parse finite nonnegative numeric input with optional k/m/% suffix; no expressions, infinities, negatives, or trailing junk. Unsuffixed token counts must be whole safe integers; suffixed/percentage values may be fractional when they resolve to a whole token count, with a documented consistent rounding rule for percentages on arbitrary window sizes. Zero is allowed for buffer only. Reject empty threshold inputs. Treat a supplied blank summary override as invalid rather than silently selecting the default.

For a context window `W`, require `0 < soft < warning <= hard <= floor(0.9 * W)`, where `hard = min(warning + buffer, floor(0.9 * W))`. Check arithmetic overflow. A warning beyond 90% is invalid, not silently lowered. A capped hard limit that equals warning is valid and immediately enforces there.

- Defaults on a 1,000,000 window: 225k/250k/270k.
- Explicit 100k/200k/50k: 100k/200k/250k and markers 10%/20%/25% on 1M.
- Explicit 20%/50%/10%: 20%/50%/60%.
- Explicit 20%/50%/0: hard equals warning at 50%.
- Default configuration on a 200k model is invalid. Explain how `--compact-soft-at 20% --compact-at 50% --compact-buffer 10%` fixes it.

Resolve at startup and on model selection. Revalidation only updates resolved values and validity; no per-model configuration store or scheduling. Invalid settings fail closed for agent work while leaving info/manual controls available. Do not rely on throwing from session_start, because Pi may catch the error and continue. Show an explicit actionable error and enforce it in the execution gate. Unknown usage is distinct from invalid settings; do not invent a zero measurement or create a lock solely from null usage.

**Feedback loop**: Start `config.test.ts` with a table covering every launch, mixed units, 0, fractions, enormous/unsafe values, 90% cap, warning over cap, equal soft/warning, small models, and model changes. Command: `pnpm exec vitest run packages/self-compact/config.test.ts`.

### 2. Soft, warning, and hard behavior

**Pattern to follow**: Pi context/event API and phase-1 tool gate. `getContextUsage()` can return null tokens/percent after compaction.

- Evaluate current usage at meaningful request/turn/tool boundaries, not a polling timer. Use the latest available measurement plus Pi's trailing-message estimate.
- At soft crossing, inject optional guidance with current tokens, percent, window, and resolved thresholds. Tools stay available.
- At warning crossing, inject stronger guidance to save the next action and call self_compact before hard. Tools still stay available.
- At hard crossing, snapshot the original active-tool selection and restrict/gate ordinary agent tools, allowing only self_compact. No automatic note fabrication and no direct forced compaction in place of the tool.
- Persist enough notification level/cycle state to avoid repeated guidance after ordinary reload. Reset level tracking on successful compaction; do not immediately loop a failed compaction attempt.
- Never start another model turn just to display a threshold notice when a task has naturally finished. Deliver guidance during ongoing work, or attach it for the next real user turn if already idle. Handoff continuation is the intentional exception.
- If one large tool output jumps directly to hard, send the relevant strongest guidance and enforce the lock; do not spam soft, warning, and hard prompts in sequence.
- When post-compaction usage is temporarily unknown, show unknown and wait for a valid measurement. A successful handoff restores prior tools, but if later measured context still exceeds hard, re-enforce appropriately without an uncontrolled compact/resume loop.

**Feedback loop**: `threshold enforcement` tests feed values just below/at/above each level, direct jumps, null usage, failure, successful reset, and idle task completion. Execute ordinary tool gates before warning and after hard, not only snapshots of registered tools. Command: `pnpm exec vitest run packages/self-compact/lifecycle.test.ts -t 'threshold enforcement'`.

### 3. Editable prompts and literal override

Package-relative files are canonical, including when launched from elsewhere:

- `.pi/self-compact/USER_PROMPT_SOFT_SELF_COMPACT.md`
- `.pi/self-compact/USER_PROMPT_WARNING_SELF_COMPACT.md`
- `.pi/self-compact/USER_PROMPT_COMPACTION_MESSAGE.md`

Use a small documented interpolation vocabulary such as `{{tokens}}`, `{{percent}}`, `{{context_window}}`, `{{soft_tokens}}`, `{{warning_tokens}}`, `{{hard_tokens}}`, and `{{hard_percent}}`. Interpolate the soft/warning files at delivery using current values. Keep note content opaque; never interpolate or trim the saved note. Do not turn literal `--compact-prompt` into a filename or template.

The soft file explicitly says guidance is optional. The warning file states that it is time to compact soon and names the hard cutoff. Both explain the note's useful contents: completed work, exact paths, verification results, next unfinished action, and whether work is already complete.

Priority for the summary system instruction: a supplied nonblank literal flag wins, otherwise the package's compaction file. Read edits on subsequent use so no install rebuild is required. Required missing/unreadable prompt files produce an actionable error and must not silently bypass required summary instructions. Catch summary errors and cancel compaction while retaining pending state, as implemented in phase 1. Preserve built-in manual focus arguments as separate summary input.

**Feedback loop**: Edit temporary prompt fixtures, vary live usage, capture actual injected content, and capture the provider's system message for file/default/literal precedence in regular and split-turn compactions. Confirm manual /compact uses the same override and the note remains a separate exact value. Command: `pnpm exec vitest run packages/self-compact/prompts.test.ts packages/self-compact/integration.test.ts -t 'prompt overrides'`.

### 4. Context widget

**Pattern to follow**: `packages/statusline/index.ts` for display math only, and Pi `setWidget` string-array API. Do not import the statusline extension or replace the footer.

Display a compact widget above the editor. Render exactly 20 cells inside brackets, each representing 5% of the full window. Fill cached cells with `#`, remaining used cells with `=`, and free cells with `-`. Clamp visual fills to 0..20. Use floor for filled cells and `ceil(percent / 5) - 1` clamped to 0..19 for threshold marker placement; markers replace cells. Priority is hard `|`, warning `!`, soft `~` when cells collide.

For explicit soft20/warn50/buffer10, usage40, cache20 percent of the model window:

```text
[###~====-!-|--------] 40%
```

Use the most recent relevant assistant usage's `cacheRead`, bounded by currently measured tokens, not a sum of cacheRead across the session. After compaction, do not reuse pre-compaction cached values as if they describe the new prompt. With no valid measurement, keep markers but label usage unknown (for example `?%`), rather than reporting 0%. The markers can overlap at default 1M token thresholds; priority remains deterministic.

Use theme semantic colors if helpful while preserving a plain-text equivalent. No configurable palette or layout knobs. Register via `ctx.ui.setWidget("self-compact", [line])`, which is also observable through RPC. Update on measured usage, config/model change, compaction state changes, and restore; clear on teardown as appropriate.

**Feedback loop**: `context widget` tests assert 20 cells and exact fixture strings for 0/40/100%, cache bounds, markers 10/20/25 on 1M, zero-buffer overlap, null usage, and post-compaction cache invalidation. Verify actual RPC `setWidget` output, not only the pure renderer. Command: `pnpm exec vitest run packages/self-compact/bar.test.ts packages/self-compact/integration.test.ts -t 'context widget'`.

### 5. Human commands

Register only `self-compact-info` and `self-compact-now`; never register/patch `compact`.

`/self-compact-info` displays raw settings, resolved token/percent thresholds, model window, current usage/cache, lock/state, cycle count, prompt source and literal-override status, pending note, and last error. It does not call a model, send a turn-triggering message, or compact. Use UI/custom display methods that also work in RPC; headless diagnostics must have an observable response. Truncate display of long notes with an explicit length indicator if necessary, but never truncate the stored/returned note.

`/self-compact-now` asks the model to write a useful note and call self_compact. When pending/failed, include the exact saved note and require retrying the tool with that note. Do not call `ctx.compact()` directly from this command and bypass the required-note workflow. If busy, use supported steering/follow-up delivery without launching concurrent compaction. Repeated invocations during active compaction must not start duplicate cycles.

Native `/compact` still operates without a pending note and does not trigger gratuitous work. With a pending note, successful manual compaction follows phase-1 recovery semantics.

**Feedback loop**: In actual Pi RPC, list commands, run info and assert no provider requests, invoke now fresh and after an injected failure, assert saved note in retry input, and exercise native manual compaction. Command: `pnpm exec vitest run packages/self-compact/integration.test.ts -t 'human commands'`.

## Testing Requirements

| Test file | Coverage |
| --- | --- |
| `config.test.ts` | Parsing/resolution and all three launch variants |
| `bar.test.ts` | Exact 20-cell rendering and cache/unknown handling |
| `lifecycle.test.ts` | Soft/warning availability, hard lock, once-per-cycle guidance, idle non-restart |
| `prompts.test.ts` | File loading/interpolation and precedence |
| `integration.test.ts` | Real flag wiring, RPC widget, command no-turn behavior, actual summary overrides |

Keep stable describe names used in contract check commands. Every required filtered run must actually execute assertions, not pass with all tests skipped. Do a TUI smoke observation of the widget alongside the existing footer; phase 3 captures durable final visual evidence.

## Failure Modes

| Component | Failure | Trigger | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| Config | Impossible threshold ordering | Small model or mid-session model change | Hard gate never reachable correctly | Validate against current window and fail closed with guidance |
| Guidance | Spam/restarted completed task | Repeated usage event at idle | Extra cost or repeated work | Once-per-level tracking and no unsolicited idle turns |
| Gate | Tools visible but executable | Only active list is changed | Hard cutoff bypass | Execution gate plus visibility restriction |
| Prompt | Wrong source/system field | Caller cwd or literal treated as filename | Override ineffective | Module-relative paths and real provider-request assertions |
| Widget | Historical cache reported as current | Summed usage or compaction stale state | Misleading bar | Last applicable request only, unknown display after compaction |
| Retry command | Note overwritten | Model rewrites pending handoff | Lost next action | Persisted note authority and exact-match retry |

## Validation Commands

```bash
pnpm exec vitest run packages/self-compact
pnpm --filter @nicknisi/pi-self-compact typecheck
pnpm --filter @nicknisi/pi-self-compact build
pnpm exec oxlint packages/self-compact
pnpm exec oxfmt --check packages/self-compact
node packages/self-compact/verify/boundary.mjs check
```

## Rollout and Commit

No global install or publishing. Preserve native /compact. Commit only this phase's verified files on `ideation/self-compact`, using a conventional commit whose body includes `docs/ideation/self-compact/spec-phase-2.md`. Final live acceptance, package README, root README, and changeset are phase 3.
