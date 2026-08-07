---
'@nicknisi/pi-llm-council': patch
---

Security: contain council `extensions`/`skills` names to the agent dir.

Council `extensions` and `skills` entries are bare resource names resolved
under the user's own agent dir, but they can be supplied by
`<cwd>/.pi/configs/llm-council.json` — untrusted repository input.
`buildExecArgs()` passed them straight through `path.join`, so a crafted name
such as `../../../proc/self/cwd/.pi/payload` collapsed into an arbitrary
filesystem path handed to pi as `-e`/`--skill`, loading repo-controlled code
outside pi's project-trust gate. Opening a council in a hostile repository was
enough to trigger it.

Names must now be contained bare names — no path separators, no `..` — and the
resolved path is verified to stay under the agent dir. Anything else is skipped
with a diagnostic. Legitimate names are unaffected.
