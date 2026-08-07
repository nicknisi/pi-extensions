---
'@nicknisi/pi-chat-input': minor
---

Add working-state whimsy: the prefix glyph animates as a spinner and the border glows (pulse or shimmer) while pi is thinking, driven by `agent_start`/`agent_settled`. Nine built-in spinner presets (`spinnerStyle`: dots, disc, moon, star, orbit, corners, triangle, scanner, mini-scanner), each with a tuned default interval, plus custom frames via `spinnerFrames`. Fully configurable via `spinner`, `spinnerStyle`, `spinnerFrames`, `spinnerIntervalMs`, `spinnerColor`, `glow`, `glowStyle`, `glowColor`, and `glowPeriodMs` in `chat-input.json`. `spinnerColor` and `glowColor` also accept the special value `"rainbow"`, which hue-rotates once per `rainbowPeriodMs`.
