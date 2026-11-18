# @nicknisi/pi-statusline (retired)

The statusline footer now lives in [`@nicknisi/pi-composer`](../composer#readme) 1.0, which renders the whole bottom of pi's screen: the input box, the footer, and the working message.

- **Footer:** composer's `classic` style is the old statusline footer (model, thinking, cost, lines changed, 5h/7d usage, context bar, branch and PR, extension statuses). It also fixes the lines-changed count, which never appeared with pi's edit tool.
- **`hiddenStatuses`:** becomes `items.statuses.hide` in `composer.json`.
- **Tmux status files** (`~/.cache/pi-status/<pane>.status`): written by [fleet's pi hook](https://github.com/nicknisi/fleet), which already wrote the same files. Running both meant two writers on one file. If you rely on these files and haven't registered the hook, run `fleet install pi` before removing statusline.
- **Notification when a run ends:** statusline ran your `claude-notify` script. Fleet's pi hook (fleet with nicknisi/fleet#111) notifies on its own instead, the way `fleet_notify` does for Claude and Codex: a tmux message when pi finishes, waits on a dialog, or asks a question, unless the pane is in view. It doesn't call `claude-notify`.

This last release is a stub that warns once per session and does nothing else. Remove it from your pi packages:

```sh
pi remove npm:@nicknisi/pi-statusline      # installed from npm
pi list                                  # installed from a local path: find it here,
pi remove /path/to/packages/statusline        # then remove that path
```
