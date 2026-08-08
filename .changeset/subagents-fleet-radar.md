---
'@nicknisi/pi-subagents': minor
---

Fleet radar overlay and ambient statusline. `Alt+Ctrl+F` (rebindable via `~/.pi/agent/keybindings.json`) opens a tmux-choose-tree-style overlay listing every run as a per-child lane — status, model, current tool, token burn, last activity — with `Enter` to inspect the live run transcript, `c` to cancel the focused run (wired into the existing cascading-cancellation registry), and `Esc` to close. While any run is in flight, a footer status segment (`ctx.ui.setStatus`) reflects live `working · done · failed` counts. The `/fleet` command and the shortcut now share one overlay opener.
