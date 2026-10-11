---
'@nicknisi/pi-shared': minor
'@nicknisi/pi-agent-urls': minor
'@nicknisi/pi-ast-grep': minor
'@nicknisi/pi-codesearch': minor
'@nicknisi/pi-llm-council': minor
'@nicknisi/pi-subagents': minor
'@nicknisi/pi-workflows': minor
'@nicknisi/pi-artifacts': patch
'@nicknisi/pi-relay': patch
---

Adopt pi 1.x tool metadata. Rarely used tools (`list_agent_runs`, `read_agent_url`, `ast_search`, `ast_rewrite`, `codesearch`, `codefetch`, `llm_council`, `fleet`, `workflow`) register as `deferred`, so they stay out of the system prompt when the built-in `tool_search` is on; without it they are declared directly as before (new `declareUnlessSearchable` helper in pi-shared). Every tool in these packages gains `annotations` for permission extensions (worst-case hints for `dispatch` and `workflow`), and `list_agent_runs` returns `structuredContent` for codemode scripts.
