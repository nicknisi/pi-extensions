# @nicknisi/pi-claude-design

## 0.1.3

### Patch Changes

- 6bfdb8e: `/design-login` now shows the authorization URL and no longer crashes pi when no browser opener is available. Token refreshes are serialized across processes, credentials are written atomically with mode 0600, token requests time out after 15s, and malformed credential files are treated as logged out.

## 0.1.2

### Patch Changes

- e434bdb: Ship `CHANGELOG.md` in the npm package so pi 1.5 can show what changed under "Extension Updates" after `pi update`.

## 0.1.1

### Patch Changes

- b67617e: shared: remove `hideLabeledSection`, `scheduleHideLabeledSection`, `clearHideTimers`, and `RequestRenderable`; their only use was pi's `[Themes]` banner, removed in pi 0.99. claude-design: setup and the `design` skill target pi's built-in MCP support (`!command` headers, `mcp__claude_design__*` tool names) instead of pi-mcp-adapter.

## 0.1.0

### Minor Changes

- 743ce71: New package: Claude Design (claude.ai/design) in pi via Anthropic's official MCP server. Adds a `design` skill that drives the full brief → artboards → preview → iterate → implement workflow, `/design-login`/`/design-status`/`/design-logout` commands, and a dependency-free `claude-design-auth` CLI whose `token` command wires into pi-mcp-adapter as a `!command` Authorization header. Same PKCE flow as Claude Code's `/design-login`; tokens refresh lazily, only when the server is actually used.
