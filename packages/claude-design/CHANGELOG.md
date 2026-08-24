# @nicknisi/pi-claude-design

## 0.1.0

### Minor Changes

- 743ce71: New package: Claude Design (claude.ai/design) in pi via Anthropic's official MCP server. Adds a `design` skill that drives the full brief → artboards → preview → iterate → implement workflow, `/design-login`/`/design-status`/`/design-logout` commands, and a dependency-free `claude-design-auth` CLI whose `token` command wires into pi-mcp-adapter as a `!command` Authorization header. Same PKCE flow as Claude Code's `/design-login`; tokens refresh lazily, only when the server is actually used.
