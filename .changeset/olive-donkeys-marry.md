---
'@nicknisi/pi-artifacts': patch
'@nicknisi/pi-chat-input': patch
'@nicknisi/pi-llm-council': patch
---

Resolve user config through pi's `getAgentDir()` instead of hardcoding `~/.pi/agent`, so these extensions honor `PI_CODING_AGENT_DIR` and work under harnesses that relocate the agent dir. Behavior is unchanged when the variable is unset.

`artifacts` resolves diff2html's stylesheet with a direct `import.meta.resolve(...)` call instead of `createRequire`, keeping it loadable under jiti and in single-file bundles.

`chat-input` now supports prefixes of any cell width. The layout math previously assumed a 1-cell prefix, so a two-cell `prefix` (e.g. `❮❯`) overflowed the box by one cell and under-indented continuation lines. Rendering is unchanged for 1-cell prefixes.
