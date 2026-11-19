---
'@nicknisi/pi-mg': patch
---

`/mg` no longer crashes pi when `afplay` or `say` is missing (audio is skipped off macOS), and it no longer throws or overflows on narrow terminals. The address phase now waits for the full monologue with subtitles synced to the speech, the departure plays in full after speech ends, and the MDR beeps actually accelerate.
