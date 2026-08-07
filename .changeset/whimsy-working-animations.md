---
'@nicknisi/pi-chat-input': minor
---

Add working-state whimsy: the prefix glyph animates as a spinner and the border glows (pulse or shimmer) while pi is thinking, driven by `agent_start`/`agent_settled`. Nine built-in spinner presets (`spinnerStyle`: dots, disc, moon, star, orbit, corners, triangle, scanner, mini-scanner), each with a tuned default interval, plus custom frames via `spinnerFrames`. Fully configurable via `spinner`, `spinnerStyle`, `spinnerFrames`, `spinnerIntervalMs`, `spinnerColor`, `glow`, `glowStyle`, `glowColor`, and `glowPeriodMs` in `chat-input.json`. `spinnerColor` and `glowColor` also accept the special value `"rainbow"`, which hue-rotates once per `rainbowPeriodMs`.

The pulse glow anchors on `borderColor` (not the focus-adjusted border), so the default `border`→`accent` pulse is visible out of the box even with `focusIndicator` on. New `/chat-input` command reloads `chat-input.json` in place (no restart) and previews the working animation for ~3 seconds; invalid JSON is now reported at startup (warning) and on reload (error, previous config kept) instead of silently falling back to defaults.
