---
'@nicknisi/pi-session-name': patch
---

Use the host's own name in the terminal title instead of hardcoding "Pi"

The unnamed-session fallback was `Pi — {dir}`, which is wrong on both paths it
takes: stock pi titles its window `π`, and a distribution that rebrands pi
(arc, tau, …) should see its own name. The title now follows pi's `APP_TITLE`
rule — `piConfig.name` from `getPackageDir()`, falling back to `π`.

`{app}` is also available as a `titleFormat` placeholder.
