# @nicknisi/pi-statusline (retired)

The statusline footer now lives in [`@nicknisi/pi-composer`](../composer#readme) 1.0, which renders the whole bottom of pi's screen: the input box, the footer, and the working message.

- **Footer:** composer's `classic` style is the old statusline footer (model, thinking, cost, lines changed, 5h/7d usage, context bar, branch and PR, extension statuses). It also fixes the lines-changed count, which never appeared with pi's edit tool.
- **`hiddenStatuses`:** becomes `items.statuses.hide` in `composer.json`.
- **Tmux status files** (`~/.cache/pi-status/<pane>.status`): written by [fleet's pi hook](https://github.com/nicknisi/fleet), which already wrote the same files. Running both meant two writers on one file.
- **`claude-notify` when a run ends:** also moved to fleet's pi hook.

This last release is a stub that warns once per session and does nothing else. Remove it from your pi packages:

```sh
pi remove npm:@nicknisi/pi-statusline
```
