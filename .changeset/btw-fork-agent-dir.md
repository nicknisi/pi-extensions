---
'@nicknisi/pi-btw': patch
---

Forked btw sessions keep a non-default agent dir. The tmux split, Ghostty window and printed `pi --session` command don't inherit pi's environment, so a pi run with `PI_CODING_AGENT_DIR` (or pi 1.7.0's `--agent-dir`) opened the fork with the default `~/.pi/agent` settings and auth. The fork now gets `PI_CODING_AGENT_DIR` passed on, which works on every pi version.
