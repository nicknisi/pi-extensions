---
'@nicknisi/pi-codemode': minor
---

`/cx <name> [args...]` runs a named codemode snippet discovered from plain TS/JS files in `~/.pi/agent/snippets/` (global) and `.pi/snippets/` (project, trusted only), mirroring pi's prompt-template discovery. Files carry optional frontmatter (`description`) for the autocomplete dropdown. `/cx` expands `{{args}}`-style substitution — `{{args}}`/`{{@}}` (all args), `{{N}}` (positional, 1-indexed), `{{N:-default}}` — then runs the snippet via the codemode runtime, binding the result to the next `$N` and persisting it as a `codemode-console` custom entry. This is a directory convention ONLY: no registry, no index, no config keys — the registry is `ls`, the package manager is `git`, the search engine is `grep`. Snippets are read on demand each invocation, so discovery rides `/reload` with no snippet-specific wiring.
