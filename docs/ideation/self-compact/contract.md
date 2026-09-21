# Self-Compaction Contract

**Created**: 2026-09-21
**Readiness**: All 5 gates ready
**Status**: Approved
**Approval**: Express — single consolidated confirmation, no per-artifact review
**Supersedes**: None

## Problem Statement

Long-running autonomous Pi agents accumulate context, increasing cost and reducing useful context quality. They need a deliberate checkpoint that preserves their exact next action and resumes work without another human message.

Pi already compacts conversations, but a reliable note-bearing self_compact tool must coordinate tool batches, idle-only compaction, durable handoff state, tool locking, custom summary instructions, and continuation. The extension must prove that these work in real Pi, not only in mocked event handlers.

## Goals

1. Ship @nicknisi/pi-self-compact as a standalone extension, loadable at packages/self-compact/extensions/self-compact/self-compact.ts, with no dependency on another extension or changes to Pi core.
2. Accept only nonblank notes of at most 24,000 characters, preserve the original note verbatim, compact once idle, restore the prior active-tool selection only after success, and resume unfinished work without another human prompt.
3. Retain the note and tool lock on cancellation or failure and through ordinary reload/resume; never routinely replay an already delivered handoff or restart completed work.
4. Provide soft, warning, and enforced context levels with validated token/percentage flags, editable prompt files, a 20-cell context widget, and /self-compact-info plus /self-compact-now while preserving built-in /compact.
5. Verify every Definition of Done item with package-local tests and durable evidence, including an actual model continuation writing result.txt containing exactly done.

## Success Criteria

- [ ] The standalone published-file layout includes the required nested extension entry point, a top-level index.ts re-export, compiled dist export, and all three editable prompt files; loading requires Pi >=0.86.1 and no other extension. — check: `pnpm --filter @nicknisi/pi-self-compact build && pnpm exec vitest run packages/self-compact/package.test.ts` → Exits 0; package-local build uses the same compiler settings and top-level source roots as scripts/build.ts without running the repository-wide emit; tests validate compiled export, packed file inclusion, required peers, no extension dependencies, and standalone resource loading.
- [ ] self_compact rejects blank/whitespace and 24,001-character notes without changing state, accepts exactly 24,000 characters, preserves whitespace verbatim, and persists the note before successful handoff. — check: `pnpm exec vitest run packages/self-compact/lifecycle.test.ts -t 'note validation'` → Exits 0 with positive boundary cases and failure assertions for invalid notes and persistence errors.
- [ ] Actual Pi lifecycle tests prove idle-only self-compaction, clean tool-batch termination, one continuation per ordinary handoff, restored prior tools, and print/JSON process survival through continuation; mixed batches and queued messages cannot silently bypass a pending handoff lock. — check: `pnpm exec vitest run packages/self-compact/integration.test.ts -t 'handoff lifecycle'` → Exits 0 using actual Pi >=0.86.1 with a deterministic provider; asserts event order, blocked sibling effects, continuation requests, and process completion, not merely a synthetic callback sequence.
- [ ] Failed/cancelled compaction and reload preserve the exact note and prior-tool snapshot, remain locked, do not spin retries, and recover through /self-compact-now or successful built-in manual compaction; delivered handoffs are not replayed on ordinary reload. — check: `pnpm exec vitest run packages/self-compact/integration.test.ts -t 'recovery'` → Exits 0 with injected summary errors/abort, persistent session reload/resume, explicit retry with the unchanged note, manual compaction recovery, branch isolation, and duplicate-delivery assertions.
- [ ] Flags parse whole tokens, k/m suffixes, percentages, and zero buffer; defaults resolve to 225k/250k/270k, 100k/200k/50k resolves to 100k/200k/250k, and 20%/50%/0 enforces at 50%. Enforce 0 < soft < warning <= hard <= 90% of the window, cap only warning+buffer, and reject malformed or incompatible settings including on model changes. — check: `pnpm exec vitest run packages/self-compact/config.test.ts` → Exits 0 with parsing, boundary, cap, 1M-model, zero-buffer, mixed-unit, invalid-default-on-small-model, and model-change cases.
- [ ] Soft and warning messages include live usage and thresholds and leave ordinary tools available; hard crossing blocks every ordinary agent tool until a successful compaction. Notifications fire once per level per cycle without waking a completed idle task. — check: `pnpm exec vitest run packages/self-compact/lifecycle.test.ts -t 'threshold enforcement'` → Exits 0; executes captured tool gates at each boundary, verifies actual prompt content, normal-tool availability before hard, forced lock at hard, and no repeated idle wakeups.
- [ ] The widget renders 20 five-percent cells, cached # / uncached = / free -, and marker priority | > ! > ~. At 40% used with half cached and explicit 20%/50%/10% settings it renders [###~====-!-|--------] 40%; a 1M window with 100k/200k/50k moves markers to 10%/20%/25%; zero buffer displays | at the overlap. Unknown usage is visibly unknown, not falsely zero. — check: `pnpm exec vitest run packages/self-compact/bar.test.ts packages/self-compact/integration.test.ts -t 'context widget'` → Exits 0 with exact uncolored strings and RPC widget output assertions; cached usage comes from the latest applicable assistant request, not cumulative session totals.
- [ ] The package-local .pi/self-compact/USER_PROMPT_SOFT_SELF_COMPACT.md and USER_PROMPT_WARNING_SELF_COMPACT.md supply editable guidance with live values. USER_PROMPT_COMPACTION_MESSAGE.md replaces the summary system instruction; literal --compact-prompt wins independently of the saved note, including built-in /compact and split-turn summaries. Summary failure must not silently fall back to Pi's default prompt. — check: `pnpm exec vitest run packages/self-compact/prompts.test.ts packages/self-compact/integration.test.ts -t 'prompt overrides'` → Exits 0; captures actual summary-provider requests and checks override precedence, normal and split-turn requests, failure cancellation, and separate verbatim note delivery.
- [ ] /self-compact-info displays settings, resolved thresholds, usage, state, cycle count, prompt sources, pending note, and last error without an LLM turn. /self-compact-now asks the model to use self_compact, reusing a pending note on retry, and the extension never registers or patches /compact. — check: `pnpm exec vitest run packages/self-compact/integration.test.ts -t 'human commands'` → Exits 0; checks command registration, info output with no provider request, fresh/retry prompts, and built-in manual compaction behavior.
- [ ] A real configured model receives one initial task, calls self_compact, completes compaction, then writes packages/self-compact/result.txt with bytes exactly done without another human prompt. A completed-task case and ordinary reload do not rewrite the result or repeat work. All three launch variants load with expected resolved settings; model-window fixtures need not spend hundreds of thousands of real tokens. — check: `node packages/self-compact/verify/live.mjs` → Exits 0 only after fresh real-model assertions; records sanitized event/summary evidence under packages/self-compact/verify/results/. Requires installed Pi >=0.86.1 and an authenticated provider, preferably the current PI_PROVIDER/PI_MODEL; missing credentials, timeouts, or skipped required checks exit nonzero. Uses reduced explicit thresholds for costly lifecycle checks and a >=300k model for the default/token launch cases.
- [ ] The new package passes focused tests and type/lint/format checks and has release metadata, root README integration, and a changeset. — check: `pnpm exec vitest run packages/self-compact && pnpm --filter @nicknisi/pi-self-compact typecheck && pnpm exec oxlint packages/self-compact && pnpm exec oxfmt --check packages/self-compact` → Exits 0; package tests verify required release metadata and integration files. Also run repository-wide typecheck/lint/format:check during final verification and report any pre-existing unrelated failures separately without expanding scope.
- [ ] All implementation/evidence writes obey the approved path boundary and preserve unrelated tracked and untracked work against a snapshot taken before implementation. — check: `node packages/self-compact/verify/boundary.mjs check` → Exits 0 only when changes outside packages/self-compact, docs/ideation/self-compact, root README.md, the generated self-compact changeset, and necessary pnpm-lock.yaml updates match the pre-build snapshot. Missing baseline fails. Store the baseline under packages/self-compact/verify/results; do not alter or restore unrelated files to make this pass.

## Scope Boundaries

### In Scope

- Note-only self_compact tool with durable session-branch state, idle scheduling, enforced tool lock, recovery, and autonomous continuation. — Core requested handoff; no useful minimum exists without safe failure handling.
- Four CLI flags and three context levels; 225k/250k/20k-buffer defaults, 90% hard cap, incompatible-setting rejection, and model-change revalidation. — Explicit threshold and launch requirements.
- Three package-local editable Markdown prompts and summary system-prompt override for extension, manual, and Pi automatic compaction. — Explicit prompt-engineering requirement; saved note remains a separate channel.
- 20-cell cached/uncached context widget plus /self-compact-info and /self-compact-now; preserve built-in /compact. — Explicit visibility and human-control requirements; a widget avoids replacing other footers.
- Standalone package, package-local automated and real-model verification, README, approved root integration, and changeset. — The requested outcome is built and verified, not only a plan or mocked demonstration.

### Out of Scope

- Pi core patches, other-extension dependencies, and refactoring existing extensions. — Standalone extension requirement and preservation of unrelated work.
- Exactly-once external side effects across arbitrary process or filesystem crashes. — User chose note-driven continuation and ordinary replay prevention rather than a transactional task system.
- New structured task/completion schema, background retry scheduler, and cross-session orchestration. — Keep the requested note-only interface and explicit retry; do not build a task runner.
- Global prompt/config files, writes into the calling project's .pi directory, replacement footer, or unrelated build-tool upgrades. — Package-local prompt ownership and strict deliverable boundary; reuse Pi widget and package-local dependencies.
- Blocking human shell/slash commands or retroactively cancelling external effects already running before a lock. — The lock gates agent tools, not the user's escape hatches or arbitrary extension code.
- Guaranteed context/cost improvement percentages, compatibility before Pi 0.86.1, or automatic npm publication. — The brief specifies operational behavior, not a benchmark, legacy support, or release deployment.

### Future Considerations

- None.

## Decisions Considered and Rejected

- **Use soft=225k, warning=250k, buffer=20k as defaults; the percentage bar is an explicitly configured fixture.** — rejected: Use 20%/50%/60% as the defaults.. User chose the brief's final token defaults in the interview.
- **Allow only root README, .changeset entry, and necessary workspace lockfile changes outside the two project directories.** — rejected: Keep the strict boundary and stop at planning.. User authorized the minimum integration required by repository policy.
- **Reject incompatible model-window settings with corrective guidance; cap only warning plus buffer at 90%.** — rejected: Scale default thresholds down automatically on small models.. User chose predictable, explicit thresholds over model-dependent default behavior.
- **Honor free-text completion in the note and prevent routine handoff replay; keep the note-only tool schema.** — rejected: Add explicit structured completion state to the tool.. User chose ordinary replay protection and unfinished-work-only continuation without arbitrary-crash exactly-once guarantees.
- **A successful built-in /compact discharges any pending note handoff.** — rejected: Keep manual compaction separate and require a second compaction through self_compact.. User chose the existing manual escape hatch as a valid recovery path.
- **Include one print-mode and one JSON-mode lifecycle check, not a cross-mode test matrix.** — The scope critic requested explicit justification: headless process survival is necessary to the brief's long-running, no-human-in-the-loop agent use case, not an unrelated UI feature.
- **Pause on failure/cancellation with the note and lock intact; retry via /self-compact-now without inventing a new note.** — Avoid unattended retry loops while preserving the requested recovery workflow.
- **Use installed Pi >=0.86.1 APIs and matching package-local development dependencies; leave the root 0.84.0 dependency pins unchanged.** — Research found required lifecycle APIs in 0.86.1 that cannot be assumed in the repository's pinned 0.84.0.
- **Verify the path boundary with a pre-build snapshot and use a top-level re-export plus package-local build to satisfy the existing publish contract.** — The success-criteria critic noted tests cannot prove untouched unrelated work; the hidden-dependency critic identified scripts/build.ts's flat entry-point and dist requirements. Package-local emit avoids writing generated deliverables in unrelated packages.
- **Use a widget and Pi's existing compaction implementation where its exported API permits replacing the summary system message.** — Avoid footer conflicts and preserve Pi's split-turn/file-tracking behavior without building a second compaction engine.

## Execution Plan

_Added during Phase 5 handoff. Pick up this contract cold and know exactly how to execute._

### Dependency Graph

```
Durable self-compaction lifecycle
  └── Threshold controls and context UI  (blocked by Durable self-compaction lifecycle)
        └── Live acceptance and release integration  (blocked by Threshold controls and context UI)
```

### Execution Steps

**Run the project** (recommended) — autopilot reads this contract, plans dependency waves, runs independent phases in parallel, and gates on failure:

```bash
/ideation:autopilot docs/ideation/self-compact/contract.md
```

**Or run it unattended** — a `/goal` is a durability wrapper around the same autopilot run: Claude re-checks the condition before it is allowed to stop, so failures get repaired and re-run. Generated by `contract-gen --print-goal`; this is the only copy of that string:

```
/goal Drive the Self-Compaction contract (self-compact) to completion with /ideation:autopilot.

1. Run `/ideation:autopilot docs/ideation/self-compact/contract.md`. All commits belong on branch ideation/self-compact — switch to it before any run.
2. It dispatches a BACKGROUND workflow. Wait for the completion notification — never start a second autopilot run while one is in flight.
3. Then run the ideation plugin's `scripts/verify.mjs` against `docs/ideation/self-compact/contract-data.json` and leave its VERIFY line in the conversation. Resolve the plugin's install directory first — `${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs` is a placeholder, not a shell variable, and bash will not expand it. That line is the only evidence this goal is judged on.
4. If anything failed, fix the spec or the implementation and go back to step 1. Autopilot skips phases that already have commits.

Done when the most recent VERIFY line reads fail=0 and commits=3/3 — or when two consecutive VERIFY lines are identical and still failing, in which case name the failing checks and stop, because a contract whose checks have rotted must not trap the run.
```

**Or run phases manually** in dependency order:

**Strategy**: Sequential: prove lifecycle correctness first, add controls and presentation second, complete real-model acceptance and release integration last.

1. **Phase 1** — Durable self-compaction lifecycle _(blocking)_

   ```bash
   /ideation:execute-spec docs/ideation/self-compact/spec-phase-1.md
   ```

2. **Phase 2** — Threshold controls and context UI _(blocking)_

   ```bash
   /ideation:execute-spec docs/ideation/self-compact/spec-phase-2.md
   ```

3. **Phase 3** — Live acceptance and release integration _(blocking)_

   ```bash
   /ideation:execute-spec docs/ideation/self-compact/spec-phase-3.md
   ```

---

_This contract was generated from brain dump input. Review and approve before proceeding to specification._
