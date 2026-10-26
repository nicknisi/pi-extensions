---
'@nicknisi/pi-workflows': minor
'@nicknisi/pi-shared': patch
---

Workflows cut off by pi quitting, reloading, switching sessions, or crashing relaunch on their own when you reopen the session that started them. Finished agents replay from the journal; only the agent that was cut off, and those after it, run again. The result arrives as a `Resumed workflow …` message. `run.json` now records the owning session and pi's process id, and a stop caused by the session ending is marked `interrupted` rather than plain `stopped`. `workflow stop` still stops for good.

shared: export `pidAlive(pid)`.
