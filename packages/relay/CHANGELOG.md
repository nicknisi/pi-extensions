# @nicknisi/pi-relay

## 0.2.0

### Minor Changes

- 82bdcd2: Durable claimable aliases and explicit thread tokens. `claim { to: "@ci" }` binds an @alias to this session's address — persisted in the registry (survives restart), last-claim-wins, swept when the owning session's record is reaped (resumable-but-offline keeps both). Any session can target `to: "@ci"`. Thread tokens are now explicit: every send/ask returns its message id and `reply` requires `replyTo` (the ask/message id or unique prefix) — the inferred-single-pending-ask fallback is removed so identical calls no longer change semantics based on invisible broker state.
- 82bdcd2: Append-only audit log written from the deposit/deliver choke points (mailbox.ts) so drain-as-receipt no longer destroys evidence. Every send/ask/reply/cancel/deliver appends one line-delimited JSON record to `<PI_RELAY_DIR>/audit.log` with timestamp, event, kind, from/to addresses, and message id — never the full body (≤80-char preview only). New `/relay log [N]` command renders the last N entries (default 50); survives corrupt lines and is `0600`/append-only.
- 82bdcd2: Broadcast and presence watch. `send` with `to: "*"` fans out to every other session and `to: "cwd"` to sessions in this session's cwd — implemented as N atomic deposits through the existing deposit path so the rate cap still bounds total fan-out; dedupe is now per-peer (loop-breaking stays per-peer) so one body reaches distinct peers instead of being dropped after the first, and each delivery gets its own audit line + receipt verdict. `watch { to }` subscribes this session to a peer's presence transitions; a 5s unref'd poller surfaces offline↔idle↔working changes as `relay:notify` system messages without waking a busy agent. A standalone `pi relay` CLI is intentionally deferred as a core-runtime concern.

## 0.1.0

### Minor Changes

- 94bbfe6: New package: brokerless session-to-session messaging (renamed from the briefly-published `@nicknisi/pi-intercom@0.0.0`, itself a drop-in replacement for nicobailon/pi-intercom). File mailbox under `~/.pi/agent/relay/` — no daemon; addresses survive `pi -c` resume; offline sessions collect mail on return; consumption-is-the-receipt delivery; pid+heartbeat presence; structural loop-breaking; authority-boundary preamble on every delivery. One `relay` tool (list, list-cwd, send, ask, reply, pending, cancel, status) plus `/relay`.
- 29eaae8: TUI surfaces for the platform: dispatch gets live per-task progress (renderCall/renderResult with council-style status trees) plus a background-runs widget; `/fleet` is now an interactive overlay with drill-down run details (text fallback when headless); intercom deliveries render as styled peer-mail cards with an aligned `/intercom` listing; codemode gets renderCall/renderResult with collapsed output, log tree, and error states.

### Patch Changes

- cacb4cc: Fleet/runtime hardening: startup GC of run artifacts (7-day retention, removes patches + worktrees too) and reaping of ghost `running` records from dead host processes; `fleet` gains `action: 'cancel'` for live runs; `fleet result` shows worktree handoff and transcript; concurrent `dispatch` calls no longer cross-wire the live progress tree (keyed by toolCallId). Workflow `sharesTree` handoff now lists untracked files and marks 64KB truncation explicitly. Intercom: live-peer receipts poll up to ~3s before settling on `queued` (fixes watch-latency false queued). Repo: the smoke suite is now committed (`scripts/smoke-stack.sh`) with a CI job that runs it when ANTHROPIC_API_KEY is configured.
