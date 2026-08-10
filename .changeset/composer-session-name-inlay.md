---
'@nicknisi/pi-composer': minor
---

Inlay the session name in the composer's border when the session has one (set via `/name`, `--name`, or the session-name extension's auto-naming). Long names are truncated with an ellipsis and the inlay hides when the composer is too narrow. New composer.json options: `sessionName` (default `true`), `sessionNameColor` (default `"muted"`), `sessionNamePosition` (`"right"` | `"left"`), `sessionNameFormat` (surround template, default `"─ {name} ─"`), `sessionNameMaxWidth` (cell cap, default `0` = fit the rule), and `sessionNameBorder` (`"top"` | `"bottom"`).
