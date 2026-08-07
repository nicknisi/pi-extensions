---
'@nicknisi/pi-pin-last-prompt': patch
'@nicknisi/pi-claude-compat': patch
'@nicknisi/pi-orchestrate': patch
'@nicknisi/pi-session-name': patch
'@nicknisi/pi-llm-council': patch
'@nicknisi/pi-agent-urls': patch
'@nicknisi/pi-auto-theme': patch
'@nicknisi/pi-chat-input': patch
'@nicknisi/pi-statusline': patch
'@nicknisi/pi-turn-timer': patch
'@nicknisi/pi-artifacts': patch
'@nicknisi/pi-save-md': patch
'@nicknisi/pi-handoff': patch
'@nicknisi/pi-spinner': patch
'@nicknisi/pi-answer': patch
'@nicknisi/pi-header': patch
'@nicknisi/pi-shared': patch
'@nicknisi/pi-cloak': patch
'@nicknisi/pi-recap': patch
'@nicknisi/pi-stash': patch
'@nicknisi/pi-btw': patch
'@nicknisi/pi-mg': patch
---

Publish compiled JS alongside the TypeScript sources.

`exports` now resolves to `./dist/index.js` and `./dist/index.d.ts`, while the
`pi` manifest keeps pointing at `./index.ts`. pi is unaffected — it loads
extensions through jiti, which transpiles TypeScript on the fly, and local path
installs still need no build step.

This fixes every _other_ consumer. Node refuses to strip types inside
`node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so anything
`tsc`-built that imported one of these packages crashed at runtime on the raw
sources. Bundlers and type resolution get a proper entry point too.
