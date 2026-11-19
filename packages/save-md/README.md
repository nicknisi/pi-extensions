# @nicknisi/pi-save-md

Save the most recent assistant response in the current session to a Markdown file in the working directory. It exists because pi has no built-in way to export a single response to a file — the full session transcript lives in pi's session storage, but extracting just the latest answer as a standalone `.md` requires digging through that store. This extension adds one slash command, `/save-md`, that does it in place.

## What it adds

- Slash command: `/save-md <name>`

No tools, keybindings, widgets, overlays, event hooks, or custom message/entry types.

## Usage

```
/save-md notes
/save-md notes.md
/save-md research/api-comparison
```

Behavior:

1. Waits for the agent to be idle (`ctx.waitForIdle()`), so invoking it while a response is streaming waits for the response to finish.
2. Walks the current session branch backwards (`ctx.sessionManager.getBranch()`) to find the latest assistant message that has text content. Assistant messages with no text (aborted or errored turns, tool-call-only turns) are skipped, so an earlier answer on the branch is saved instead.
3. Extracts only `text` content blocks from that message, joining them with blank lines. Non-text blocks (tool calls, thinking, images) are dropped.
4. Appends `.md` if the name doesn't already end in it, resolves the path relative to `ctx.cwd`, and writes the file. Absolute paths and `../` segments are honored as given, so the target can be outside the working directory.
5. Ensures the file ends with a trailing newline.

Examples:

```
/save-md summary        → writes <cwd>/summary.md
/save-md docs/plan      → writes <cwd>/docs/plan.md (docs/ must already exist)
```

Failure modes, all reported via `ctx.ui.notify`:

| Condition                                   | Level   | Message                                                  |
| ------------------------------------------- | ------- | -------------------------------------------------------- |
| No assistant message in the current branch  | warning | `No assistant response to save`                          |
| Empty `<name>` argument                     | warning | `Usage: /save-md name`                                   |
| No assistant message on the branch has text | warning | `No assistant response on this branch has Markdown text` |
| Target file already exists                  | error   | `File already exists: <path>`                            |
| Any other write error (missing dir, EACCES) | error   | `Failed to save <path>: <error message>`                 |

## Configuration

None. No config files are read, no options exist, and no environment variables are consulted.

## Dependencies

Peer dependencies (both `*`):

- `@earendil-works/pi-coding-agent` — `ExtensionAPI` type. At runtime uses `pi.registerCommand`, `ctx.waitForIdle`, `ctx.sessionManager.getBranch`, `ctx.ui.notify`, and `ctx.cwd`.
- `@earendil-works/pi-ai` — `AssistantMessage` type only.

Runtime dependencies: Node builtins `node:fs/promises` (`writeFile`) and `node:path` (`resolve`). No npm dependencies, no workspace deps.

## Caveats

- **Only text blocks are saved.** Tool calls, tool results, thinking blocks, and any other non-`text` content in the assistant message are silently omitted. If the last assistant turn was purely tool calls with no final text, the command falls back to the most recent earlier assistant message with text; if none has text, it reports there is nothing to save.
- **Current branch only.** `getBranch()` returns the active branch of the session tree; messages on other branches are not considered.
- **No overwrite.** The file is written with flag `wx` (exclusive create). Re-running `/save-md` with the same name reports `File already exists` rather than overwriting. Delete the file or pick a new name.
- **No directory creation.** Parent directories of the target path must already exist; otherwise the write fails and is reported as `Failed to save <path>: …`.
- **Pi internals.** Depends on the session entry shape (`entry.type === "message"`, `entry.message.role`) and on `ctx.sessionManager.getBranch()` / `ctx.ui.notify` APIs, any of which could change across pi versions. The content-block filter is written defensively (structural checks, no casts) to tolerate shape drift in message content.

## Install

```
pi install /Users/nicknisi/Developer/pi-extensions/packages/save-md
```
