# @nicknisi/pi-stash

Replicates Claude Code's message stash using `ctrl+s`. Rebind Pi's built-in `ctrl+s` actions as shown below to avoid shortcut conflicts. Press `ctrl+s` to stash whatever you've typed in the input editor, go do something else, then press `ctrl+s` again with an empty editor to pop the most recent stash back. Stashes live on a stack, so multiple drafts can be parked and restored LIFO.

## What it adds

- **Keybinding:** `ctrl+s` toggles stash/restore. See the behavior table below.
- **Widget:** a single-line widget above the editor, visible whenever the stash stack is non-empty, showing a 60-char preview of the most recent stash, the count of additional stashes (`(+N more)`), and a `ctrl+s to restore` hint
- **Events hooked:**
  - `before_agent_start`: after a message is submitted and the agent starts, this session's most recent stash is auto-restored into the now-empty editor (mirrors Claude Code).
  - `session_start`: shows the widget for drafts already saved for this directory.
- No slash commands, no tools, no custom entry types.

### Keybinding behavior

| Editor state on `ctrl+s`                  | Action                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| Contains text                             | Push text onto the stack, clear the editor                                     |
| Empty (or whitespace) and stack non-empty | Pop the most recent stash into the editor (from any session in this directory) |
| Empty and stack empty                     | No-op                                                                          |

## Usage

```text
(type a long prompt, then need to ask something else first)
ctrl+s      "⧉ stashed: Refactor the auth module to..." · editor cleared
(ask the other question; on submit, the stashed draft is restored automatically)
ctrl+s      (with empty editor) pops the stash back manually
```

## Persistence

Drafts are saved per working directory in `<agentDir>/stash/<hash of cwd>.json` (normally `~/.pi/agent/stash/`), so they survive `/reload`, quitting Pi, and starting a new session in the same directory. Every change re-reads the file and replaces it atomically (a temporary file renamed into place, mode `0600`). The stack keeps the newest 10 drafts and drops the oldest.

Each draft remembers the session that stashed it. Sending a message only auto-restores drafts from the current session, so another Pi window in the same directory never has a draft pulled into its editor. `ctrl+s` on an empty editor restores the newest draft from any session.

If the stash file can't be read or parsed, the extension reports an error and leaves both the file and the editor text alone, rather than overwriting what may be the only copy of a draft.

## Configuration

The stash shortcut is fixed at `ctrl+s`. Move Pi's built-in actions off that key in `~/.pi/agent/keybindings.json`:

```json
{
  "app.models.save": ["ctrl+shift+v"],
  "app.thinking.save": ["ctrl+shift+v"],
  "app.session.toggleSort": ["ctrl+shift+r"]
}
```

Merge these entries into your existing config, then run `/reload`. Model-save and thinking-save use separate selectors, so they can share a key. `pi-web-access` can keep its default `ctrl+shift+s` curator shortcut.

## Dependencies

- **Peer:** `@earendil-works/pi-coding-agent` (`*`). Uses only the public extension API: `pi.registerShortcut`, `pi.on("before_agent_start" | "session_start")`, `getAgentDir()`, `ctx.sessionManager.getSessionId()`, `ctx.ui.getEditorText` / `setEditorText` / `setWidget` / `notify` / `theme`, and `ctx.hasUI`.
- Node built-ins: `node:crypto`, `node:fs`, `node:path`. No runtime npm dependencies, no workspace deps.

## Caveats

- UI-gated: every handler checks `ctx.hasUI`; the extension is a no-op in headless/non-TUI mode.
- Depends on the editor text APIs (`ctx.ui.getEditorText` / `setEditorText`) and the widget system (`ctx.ui.setWidget`) — these are stable pi extension APIs, but a pi version that changes editor or widget semantics could affect it.
- The `before_agent_start` auto-restore pops a stash whenever a message is sent with an empty editor. If you intentionally sent a quick command and wanted the stash to stay parked, it will still be restored into the editor (you can `ctrl+s` it back). This matches Claude Code's behavior.
- There is no cross-process lock: two windows changing the same directory's stash in the same instant can lose one draft.
- The shifted replacement shortcuts require a terminal that reports them distinctly, for example through the Kitty keyboard protocol. The widget preview uses the Unicode glyphs `⧉` and `…`.

## Install

```bash
pi install /Users/nicknisi/Developer/pi-extensions/packages/stash
```
