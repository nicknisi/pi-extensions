# Self-Compaction — Phase 3 Verification Results

Actual recorded outcomes for the live acceptance and release-integration phase.
Machine-local evidence (`result.txt`, `verify/results/`, session files) is
git-ignored and regenerated on each run; the tracked/released package excludes
all of it via the `files` allowlist.

## Environment

- Runtime: package-local Pi bundle CLI `0.86.1` (meets the `>=0.86.1` gate; the
  PATH `pi` is older and is deliberately not used).
- Live provider/model: `anthropic/claude-opus-4-8` (from `PI_PROVIDER`/`PI_MODEL`;
  auth resolved by Pi, never printed or copied).

## Validation commands and outcomes

| Command                                                | Exit | Notes                                                                                                          |
| ------------------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @nicknisi/pi-self-compact build`        | 0    | tsgo package-local build                                                                                       |
| `pnpm exec vitest run packages/self-compact`           | 0    | 126 tests passed (config, bar, prompts, lifecycle, integration, package, boundary)                             |
| `pnpm --filter @nicknisi/pi-self-compact typecheck`    | 0    | tsgo `--noEmit`                                                                                                |
| `pnpm exec oxlint packages/self-compact`               | 0    | no findings                                                                                                    |
| `pnpm exec oxfmt --check packages/self-compact`        | 0    | clean after package-local format                                                                               |
| `node packages/self-compact/verify/live.mjs`           | 0    | self-test + bounded real-model acceptance, all PASS                                                            |
| `node packages/self-compact/verify/boundary.mjs check` | 0    | 261 unrelated files unchanged                                                                                  |
| `pnpm typecheck` (repo-wide, read-only)                | 0    | —                                                                                                              |
| `pnpm lint` (repo-wide, read-only)                     | 0    | —                                                                                                              |
| `pnpm format:check` (repo-wide, read-only)             | 1    | **Pre-existing baseline:** 31 unrelated `.pi/artifacts/` files only. Not fixed (mutating counterpart not run). |

## Live driver

`node packages/self-compact/verify/live.mjs` first runs an offline deterministic
self-test that proves the driver's own assertions reject wrong behavior, then
runs the bounded real-model acceptance. Fresh evidence is written to
`verify/results/live.json` on each run; a stale file cannot satisfy acceptance.

### Deterministic self-test (offline, no spend) — all correct

| Case                    | Expected | Actual | Correct |
| ----------------------- | -------- | ------ | ------- |
| positive-control        | ok       | ok     | yes     |
| never-writes            | fail     | fail   | yes     |
| writes-done-newline     | fail     | fail   | yes     |
| rewrites-file           | fail     | fail   | yes     |
| never-settles (timeout) | fail     | fail   | yes     |

### Live acceptance (real model) — overall PASS

- **fresh-continuation — PASS.** One valid note-bearing `self_compact` call, one
  successful compaction (`compaction_end` not aborted, summary present), the note
  delivered verbatim as a continuation, an autonomous continuation turn
  (`agent_start` count 2, no second human prompt), exactly one `write` tool call
  to `result.txt`, one delivered handoff cycle (`completedCycles === 1`), and
  `result.txt` bytes exactly `done` (4 bytes, no trailing newline).
- **reload-no-replay — PASS.** A bare reload (`--continue`, no prompt) started
  zero turns / provider requests, replayed no compaction or handoff, and left
  `result.txt` byte- and mtime-identical.
- **completed-task-note — PASS.** A status probe on the reloaded session made no
  new `self_compact` call, no new compaction, and zero writes to `result.txt`
  (no repeated completed work); the file content and mtime were unchanged.

Ownership: the driver refuses to overwrite a pre-existing `result.txt` of unclear
ownership, removing only its own prior owned result (tracked via
`verify/results/result-owner.json`) before a fresh continuation.

## UI verification

The 20-cell context widget and `/self-compact-info` (no model turn) are asserted
at the RPC level in `integration.test.ts` (`context widget`, `human commands`)
against a capturing RPC UI, with the exact 20-cell bar strings pinned in
`bar.test.ts`. A screenshot (`verify/results/ui.png`) is not captured in this
headless environment; the durable, checkable UI evidence is the RPC widget
assertion plus the exact renderer strings. This is the recorded UI limitation.

## Boundary and release hygiene

- `boundary.mjs check` confirms no unrelated tracked/untracked file changed.
- `packages/codemode/index.ts` and `packages/workflows/index.ts` remain
  byte-identical and unstaged.
- The npm `files` allowlist packs only `dist`, `index.ts`, `extensions`, and
  `.pi/self-compact` (plus `README.md`/`package.json`): no `verify/` evidence,
  no `result.txt`, no sessions, no logs, no credentials.
- A changeset (`.changeset/self-compact.md`, minor bump for
  `@nicknisi/pi-self-compact` only) is present for release.

## Remaining blockers

None. No required check was skipped.
