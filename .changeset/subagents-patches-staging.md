---
'@nicknisi/pi-subagents': minor
---

`/patches` staging area for worktree-subagent handoffs. A keyboard-driven overlay lists every pending `.patch` (from completed worktree runs) with diffstat and a pre-flight stamp — `clean` / `conflicts` / `stale` — checked via `git apply --check` **without** applying. `Enter` applies the whole patch (`git apply --3way`); `e` expands the full diff with per-hunk navigation (`n`/`p`); `s` applies the focused hunk (reconstructed as a sub-patch and `--3way`-ed); `d` discards; `Esc` closes. Apply/discard decisions persist to `~/.pi/agent/subagent-patches/state.json` so `/patches` survives restart. Cuts: single-hunk apply only (no multi-select), the diff view truncates at 2000 lines, and stale-vs-conflicts is a file-existence heuristic (the run record stores no base commit).
