---
'@nicknisi/pi-workflows': patch
---

`autoplan.js`: the human is now the decision gate — the advisor only recommends, and `ask()` presents the options (recommendation first, reject-all always offered) matching the osolmaz demo. Bundled `autoplan` skill so "autoplan this" triggers the workflow with conversation-derived args. Fixes `files` so `examples/` and `skills/` actually publish to npm.
