# Self-Compaction verification

Verified on 2026-09-21 against package-local Pi 0.86.1.
Live provider/model: `anthropic/claude-opus-4-8`, selected with
`SELF_COMPACT_LIVE_PROVIDER` and `SELF_COMPACT_LIVE_MODEL`; Pi resolves authentication.
No credentials are stored in evidence.

## Automated checks

| Check                                        | Actual result                                                     |
| -------------------------------------------- | ----------------------------------------------------------------- |
| Package-local build                          | Exit 0                                                            |
| `pnpm exec vitest run packages/self-compact` | 137 tests passed across 6 files                                   |
| Package-local typecheck                      | Exit 0                                                            |
| Package-local oxlint                         | Exit 0                                                            |
| Package-local oxfmt check                    | Exit 0                                                            |
| Repository typecheck                         | Exit 0                                                            |
| Repository lint                              | Exit 0                                                            |
| Repository format:check                      | Exit 1: the same 31 pre-existing unrelated `.pi/artifacts/` files |
| Boundary verifier                            | Exit 0: 261 unrelated files unchanged                             |
| `git diff --check`                           | Exit 0                                                            |

Tests exercise real Pi sessions and CLI subprocesses, plus focused pure-function
and handler assertions. Final integration corrections added regression coverage
for repeated checkpoints inside continuation, manual recovery after summary
failure and cancellation, interrupted-compaction reload, ordinary-tool restoration
including `self_compact`, long-running continuation beyond 30 seconds, warning
steering, hard-cutoff recovery, and locks across native tree navigation.

The independent follow-up review passed after fixing the tree-navigation lock
leak it identified. The CLI survival harness was also included after final
inspection found it had been omitted from the engine's phase commits.

## Real-model acceptance

Command:

```sh
SELF_COMPACT_LIVE_PROVIDER=anthropic SELF_COMPACT_LIVE_MODEL=claude-opus-4-8 \
  node packages/self-compact/verify/live.mjs
```

All six scenarios passed:

1. Default CLI launch resolves soft 225k, warning 250k, hard 270k.
2. Explicit token launch resolves 100k, 200k, 250k.
3. Percentage/zero-buffer launch resolves 20%, 50%, 50% and selects the literal summary override.
4. Fresh handoff makes one real `self_compact` call, compacts successfully,
   returns its verbatim note, autonomously continues, and writes `result.txt`
   exactly once with bytes `done`, without a second user prompt.
5. Bare session reload starts no agent turn, does not replay the handoff,
   exits successfully, and leaves result bytes and mtime unchanged.
6. A second handoff explicitly says the task is complete. It compacts and
   autonomously continues with that exact note, without rewriting the file.

The driver's deterministic self-tests first reject no-write, trailing-newline,
duplicate-write, and timeout outcomes while accepting the positive control.
Launch configuration checks use real CLI RPC diagnostics without model turns;
expensive token counts are not fabricated or sent solely to fill the window.

Fresh sanitized evidence: `verify/results/live.json`.
The driver refuses to overwrite an unowned `result.txt`.

## Actual terminal UI

A dedicated Terminal session loaded only the extension, using the explicit
20%/50%/zero-buffer configuration on a 1,000,000-token model. Checked UI tools
confirmed the visible `[---~-----|----------] 0%` widget above the editor and
coexisting native footer. `/self-compact-info` displayed flags, exact resolved
thresholds, all prompt paths, usage, handoff state, and cycle count without an
LLM turn. `wait_for` returned `Condition appeared.` for the resolved values.

Sanitized state IDs, tool outcomes, and decisive UI excerpts are recorded in
`verify/results/ui-evidence.md`. No screenshot is retained because the terminal
window title contained unrelated environment metadata. The scratch session and
window were closed after verification. Exact 40%-half-cached rendering is covered
by deterministic tests rather than a costly synthetic live prompt.

## Release and preservation

- The manifest requires Pi peers >=0.86.1 and loads the requested nested source entry.
- Packed files include the compiled export, source helpers, and all three editable prompts.
- Root README integration and `.changeset/self-compact.md` are present.
- User edits in `packages/codemode/index.ts` and `packages/workflows/index.ts`
  remain unchanged and are not part of project commits.
- Machine-local evidence and session files remain under this package's ignored
  `verify/results/` directory; result.txt is local evidence, not published code.
- Only the original unrelated repository formatting failures remain.
