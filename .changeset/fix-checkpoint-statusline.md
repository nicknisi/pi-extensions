---
'@nicknisi/pi-checkpoint': patch
'@nicknisi/pi-statusline': patch
---

checkpoint: switching to a model with a larger context window now lifts the hard-cutoff tool lock when usage is below the new cutoff, unless a handoff is pending. statusline: the tmux session name is resolved once per session instead of with a synchronous `tmux` call on every tool call.
