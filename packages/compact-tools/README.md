# pi-compact-tools

Collapse every tool display to a header and one preview line. Press **Ctrl+O** to expand all tools, or click a tool in Pi's fullscreen mode to expand just that tool.

```text
▸ $ pnpm test
  Test run started … [ctrl+o]
```

Only the display changes. Tool execution, saved results, images, details, and model context stay untouched. Expanding restores the tool's original renderer, including syntax highlighting, diffs, and custom extension displays.

## Install

From a local checkout:

```bash
pi install /absolute/path/to/pi-extensions/packages/compact-tools
```

After publication:

```bash
pi install npm:@nicknisi/pi-compact-tools
```

Restart Pi or run `/reload` after installation.

## Behavior

| Action or state               | Display                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| Before a result arrives       | One line using the tool's normal human-readable header                              |
| Streaming or completed result | Header plus one readable preview line                                               |
| Multiline output              | An ellipsis after the preview                                                       |
| Success                       | Both lines use Pi's green `toolSuccessBg` background                                |
| Running                       | Both lines use Pi's `toolPendingBg` background                                      |
| Error                         | Both lines use Pi's red `toolErrorBg` background, with an explicit `Error:` preview |
| Images                        | An image count instead of inline images                                             |
| Ctrl+O                        | Pi's existing expand/collapse toggle for all tools                                  |
| Fullscreen left click         | Expand one collapsed tool. Click its original header or result to collapse it again |

There is one blank separator before each tool. Long lines truncate to the terminal width rather than wrapping. Built-in, extension, MCP, dynamically registered, and restored tool rows all use the same compact display. Headers reuse the tool's existing renderer, such as `read src/index.ts` or `$ pnpm test`. Tools without a custom header show their name and a path, command, query, action, or URL when available. The fallback never dumps JSON arguments or file contents.

Tools start collapsed on session start and reload. The key hint follows your `app.tools.expand` binding in `~/.pi/agent/keybindings.json`. No new tools, commands, shortcuts, widgets, or session entry types are registered.

## Configuration

None. The default is two content lines. Use Pi's existing expansion controls when you need more detail.

## Dependencies and caveats

- Pi supplies `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` as peer dependencies. `@nicknisi/pi-shared` supplies terminal-label sanitization.
- Keyboard compaction works with Pi 0.84 and 0.85. Fullscreen click expansion needs Pi 0.85.1 or newer. Regular terminal mode leaves mouse input to terminal scrollback, so use Ctrl+O there.
- Pi has no public global tool-rendering hook. This extension wraps `ToolExecutionComponent.render` and its mouse handler, reading the component's private display state. A Pi update can break this integration. Missing required methods produce a warning and leave the original display in place.
- The wrapper is installed only in TUI sessions and removed on session shutdown, including reload. Print, JSON, and RPC sessions are unchanged.
- Previews use the tool's existing result renderer when available, falling back to the first nonempty output line. JSON-only output shows an item or field count instead of serialized data. No model call is made. Custom controls and detailed progress displays are available when expanded.
- Expanded displays retain each tool's own limits. This extension cannot recover output already truncated by a tool.
- Other extensions that replace the same component methods can conflict. This extension does not overwrite a later wrapper during cleanup.
- User shell commands entered with `!` or `!!` use a separate Pi component and are unchanged.

## Development

```bash
pnpm test -- packages/compact-tools/index.test.ts
pnpm typecheck
pnpm lint
```
