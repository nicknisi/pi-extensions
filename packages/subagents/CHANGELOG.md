# @nicknisi/pi-subagents

## 0.3.0

### Minor Changes

- 4fff6f8: Scope the default fleet command, shortcut, tool list, and footer indicator to active subagents owned by the current Pi session, with explicit `all` access to persisted machine-wide history. Propagate owner-session metadata through codemode and workflows without enabling session mirrors. Add a global statusline `hiddenStatuses` denylist for suppressing extension-provided footer segments.

### Patch Changes

- Updated dependencies [4fff6f8]
  - @nicknisi/pi-shared@0.5.0

## 0.2.2

### Patch Changes

- bdef70f: Fix dispatch progress rendering each task twice while running. pi keeps the renderCall component on screen next to renderResult once the first onUpdate fires, and both rendered the same task tree — renderCall now renders only the header, renderResult owns the tree.

## 0.2.1

### Patch Changes

- Updated dependencies [9cd49ce]
  - @nicknisi/pi-shared@0.4.0

## 0.2.0

### Minor Changes

- 00958ee: Deterministic cascading cancellation: a `session_shutdown` handler (quit/reload/new/resume/fork) now aborts every active child — foreground tasks were already aborted via the tool signal, but background runs (which deliberately carry no tool signal) only died with the process before. Aborted runs no longer capture a `.patch` and remove their worktree immediately, so an interrupt or parent exit can't leak a detached worktree; `sweepRunArtifacts` now also removes a ghost run's worktree when reaping it on next startup (closes the hard-exit/SIGKILL leak path). README documents the full worktree cleanup policy (when worktrees are removed, what happens to unclaimed `.patch` files).
- 00958ee: Persist subagent runs as standard pi sessions (additive dual-write). Every `dispatch` run now ALSO writes a standard pi session JSONL via the real `SessionManager` (from `@earendil-works/pi-coding-agent`) into the default sessions dir, with the session header's `parentSession` set to the owning pi session's file path — so runs show up in pi's native `/resume`, `/tree`, and `--fork` machinery. New `SpawnOptions.parentSession` opts into the mirror; the resulting path is recorded on `RunRecord.sessionFile` and shown by `fleet` `result`. The bespoke `.json` run store is unchanged (fleet/registry still read it). Opt-in keeps other shared-runtime consumers (codemode/workflow) unaffected. Compat caveats: no mirror when the owning session is in-memory (print mode), and no file when the child produced no assistant turn (SessionManager creates the JSONL lazily on the first assistant message).
- efef393: `&` dispatch prefix and `/again`. `&scout how does auth work` at position zero intercepts the input (`on("input")` → `{action:"handled"}`, the documented `?quick`-style mechanism) and dispatches a single subagent inline, reusing the same `spawnCancellable` path as the `dispatch` tool. Live progress renders in an editor widget; the settled result lands as a collapsible `subagents:inline` custom message (registered via `registerMessageRenderer`) that reuses the `renderTaskTree` / `createExpandedDispatchView` machinery, and the answer is added to model context. Every dispatch is captured as a `subagents:dispatch` custom entry (`appendEntry`) so it survives restart, and `/again [amendment]` re-fires the last dispatch verbatim or with an amendment appended. Cut: an inline run is registered in the cascading-cancellation registry (aborted on shutdown, cancellable from the fleet radar) but is not aborted by a bare Esc — the `input` event fires while idle, so no agent abort signal is available to thread into the child.
- efef393: Fleet radar overlay and ambient statusline. `Alt+Ctrl+F` (rebindable via `~/.pi/agent/keybindings.json`) opens a tmux-choose-tree-style overlay listing every run as a per-child lane — status, model, current tool, token burn, last activity — with `Enter` to inspect the live run transcript, `c` to cancel the focused run (wired into the existing cascading-cancellation registry), and `Esc` to close. While any run is in flight, a footer status segment (`ctx.ui.setStatus`) reflects live `working · done · failed` counts. The `/fleet` command and the shortcut now share one overlay opener.
- efef393: `/patches` staging area for worktree-subagent handoffs. A keyboard-driven overlay lists every pending `.patch` (from completed worktree runs) with diffstat and a pre-flight stamp — `clean` / `conflicts` / `stale` — checked via `git apply --check` **without** applying. `Enter` applies the whole patch (`git apply --3way`); `e` expands the full diff with per-hunk navigation (`n`/`p`); `s` applies the focused hunk (reconstructed as a sub-patch and `--3way`-ed); `d` discards; `Esc` closes. Apply/discard decisions persist to `~/.pi/agent/subagent-patches/state.json` so `/patches` survives restart. Cuts: single-hunk apply only (no multi-select), the diff view truncates at 2000 lines, and stale-vs-conflicts is a file-existence heuristic (the run record stores no base commit).

### Patch Changes

- 1f032e3: /fleet detail view now shows live activity for running agents: turn/tool-call counts in the meta line, a live transcript tail (last 10 events), and a 1s refresh so an open detail tracks the run instead of showing a frozen "(still running — no output yet)" stub.
- Updated dependencies [00958ee]
- Updated dependencies [1f032e3]
- Updated dependencies [00958ee]
- Updated dependencies [efef393]
  - @nicknisi/pi-shared@0.3.0

## 0.1.0

### Minor Changes

- 9006737: New package: first-party subagent dispatch and fleet. `dispatch` fans out up to 8 hermetic in-process child agents in parallel (per-task prompts, models, tool allowlists, background flag); `fleet` (tool) and `/fleet` (command) inspect live and persisted runs across extensions using the shared runtime. No pi-subagents dependency.
- 29eaae8: TUI surfaces for the platform: dispatch gets live per-task progress (renderCall/renderResult with council-style status trees) plus a background-runs widget; `/fleet` is now an interactive overlay with drill-down run details (text fallback when headless); intercom deliveries render as styled peer-mail cards with an aligned `/intercom` listing; codemode gets renderCall/renderResult with collapsed output, log tree, and error states.
- cacb4cc: Worktree isolation for builder agents. `spawn({ worktree: true })`, dispatch tasks with `worktree: true`, and workflow stages with `worktree: true` run in a detached git worktree (`~/.pi/agent/subagent-worktrees/<runId>`) — writes never touch the caller's tree, mutating tools stay parallel without `allowTreeMutation`, and the full change set (including untracked files, via `git add -A` + `git diff --cached HEAD`) is captured untruncated to `<runId>.patch` beside the run artifact. Merge-back stays central: inspect the patch, apply what you want. Also: bounded child transcripts (last 20 events) on run records, a process-wide child budget (8) under the per-runtime cap, and a `specHash` guard so `resumeFrom` fails loudly when stage definitions changed.
- 73c772e: Worktree isolation for builder agents. `spawn({ worktree: true })`, dispatch tasks with `worktree: true`, and workflow stages with `worktree: true` run in a detached git worktree (`~/.pi/agent/subagent-worktrees/<runId>`) — writes never touch the caller's tree, mutating tools stay parallel without `allowTreeMutation`, and the full change set (including untracked files, via `git add -A` + `git diff --cached HEAD`) is captured untruncated to `<runId>.patch` beside the run artifact. Merge-back stays central: inspect the patch, apply what you want. Also: bounded child transcripts (last 20 events) on run records, a process-wide child budget (8) under the per-runtime cap, and a `specHash` guard so `resumeFrom` fails loudly when stage definitions changed.

### Patch Changes

- cacb4cc: Fleet/runtime hardening: startup GC of run artifacts (7-day retention, removes patches + worktrees too) and reaping of ghost `running` records from dead host processes; `fleet` gains `action: 'cancel'` for live runs; `fleet result` shows worktree handoff and transcript; concurrent `dispatch` calls no longer cross-wire the live progress tree (keyed by toolCallId). Workflow `sharesTree` handoff now lists untracked files and marks 64KB truncation explicitly. Intercom: live-peer receipts poll up to ~3s before settling on `queued` (fixes watch-latency false queued). Repo: the smoke suite is now committed (`scripts/smoke-stack.sh`) with a CI job that runs it when ANTHROPIC_API_KEY is configured.
- Updated dependencies [cacb4cc]
- Updated dependencies [121a19d]
- Updated dependencies [c60bd34]
- Updated dependencies [0aabf31]
- Updated dependencies [0aabf31]
- Updated dependencies [cacb4cc]
- Updated dependencies [73c772e]
  - @nicknisi/pi-shared@0.2.0
