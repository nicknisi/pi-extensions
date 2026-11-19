---
'@nicknisi/pi-claude-compat': patch
---

Dynamic `!`command`` placeholders now run in the project directory, `/skill:` expansion matches pi's own `<skill>` format, commands are aborted when the turn is cancelled, and `~`/`@`/symlinked SKILL.md reads are recognized. `CLAUDE_PLUGIN_ROOT` is no longer left set after shutdown, and the rewrite no longer mangles `$CLAUDE_PLUGIN_ROOT /x` or `${CLAUDE_PLUGIN_ROOT:-x}`.
