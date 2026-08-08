---
'@nicknisi/pi-shared': patch
'@nicknisi/pi-subagents': patch
'@nicknisi/pi-relay': patch
---

Fleet/runtime hardening: startup GC of run artifacts (7-day retention, removes patches + worktrees too) and reaping of ghost `running` records from dead host processes; `fleet` gains `action: 'cancel'` for live runs; `fleet result` shows worktree handoff and transcript; concurrent `dispatch` calls no longer cross-wire the live progress tree (keyed by toolCallId). Workflow `sharesTree` handoff now lists untracked files and marks 64KB truncation explicitly. Intercom: live-peer receipts poll up to ~3s before settling on `queued` (fixes watch-latency false queued). Repo: the smoke suite is now committed (`scripts/smoke-stack.sh`) with a CI job that runs it when ANTHROPIC_API_KEY is configured.
