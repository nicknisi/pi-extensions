---
'@nicknisi/pi-artifacts': patch
---

Renderers now load on first use instead of at every pi startup. Headless Chrome and `gh` shares can be cancelled with Esc and time out after 60 seconds, and gist shares with comments use a private temp directory. Titles containing `&`, `<` or `>` now display correctly in `list`, `/artifacts`, the index page and gist descriptions. `open` now reports the artifact's real kind, and test browsers are also blocked from the `*.localhost` content origins. The dev-only `smoke.mjs` is no longer published.
