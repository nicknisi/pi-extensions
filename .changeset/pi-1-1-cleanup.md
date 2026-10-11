---
'@nicknisi/pi-shared': minor
'@nicknisi/pi-claude-design': patch
---

shared: remove `hideLabeledSection`, `scheduleHideLabeledSection`, `clearHideTimers`, and `RequestRenderable`; their only use was pi's `[Themes]` banner, removed in pi 0.99. claude-design: setup and the `design` skill target pi's built-in MCP support (`!command` headers, `mcp__claude_design__*` tool names) instead of pi-mcp-adapter.
