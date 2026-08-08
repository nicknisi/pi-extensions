---
'@nicknisi/pi-codemode': minor
---

codemode joins pi's editor prefix grammar (`!` bash, `!!` silent bash, `@` files) as the `=` member. `=<snippet>` at position zero runs the snippet through the codemode runtime inline, devtools-console style — the snippet executes with the same `spawn`/`log`/`runWorkflow` bindings as the `codemode` tool, the result renders as a collapsible block (toggled with the same `app.tools.expand` key as tool output), and the returned value binds to `$1`, `$2`, … for later console snippets in the session. Each run is persisted as a session custom entry (`customType: 'codemode-console'`) so the console history survives reload; `$1…` are rebuilt from those entries on session start. The `=` prefix is intercepted via `on("input")` with `{ action: "handled" }` (TUI only; extension-injected and non-tui inputs pass through) and respects the schema-or-nothing spawn contract.
