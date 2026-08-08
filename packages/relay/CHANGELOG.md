# @nicknisi/pi-relay

## 0.1.0

### Minor Changes

- 94bbfe6: New package: brokerless session-to-session messaging (renamed from the briefly-published `@nicknisi/pi-intercom@0.0.0`, itself a drop-in replacement for nicobailon/pi-intercom). File mailbox under `~/.pi/agent/relay/` — no daemon; addresses survive `pi -c` resume; offline sessions collect mail on return; consumption-is-the-receipt delivery; pid+heartbeat presence; structural loop-breaking; authority-boundary preamble on every delivery. One `relay` tool (list, list-cwd, send, ask, reply, pending, cancel, status) plus `/relay`.
- 29eaae8: TUI surfaces for the platform: dispatch gets live per-task progress (renderCall/renderResult with council-style status trees) plus a background-runs widget; `/fleet` is now an interactive overlay with drill-down run details (text fallback when headless); intercom deliveries render as styled peer-mail cards with an aligned `/intercom` listing; codemode gets renderCall/renderResult with collapsed output, log tree, and error states.

### Patch Changes

- cacb4cc: Fleet/runtime hardening: startup GC of run artifacts (7-day retention, removes patches + worktrees too) and reaping of ghost `running` records from dead host processes; `fleet` gains `action: 'cancel'` for live runs; `fleet result` shows worktree handoff and transcript; concurrent `dispatch` calls no longer cross-wire the live progress tree (keyed by toolCallId). Workflow `sharesTree` handoff now lists untracked files and marks 64KB truncation explicitly. Intercom: live-peer receipts poll up to ~3s before settling on `queued` (fixes watch-latency false queued). Repo: the smoke suite is now committed (`scripts/smoke-stack.sh`) with a CI job that runs it when ANTHROPIC_API_KEY is configured.
