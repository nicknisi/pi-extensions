# @nicknisi/pi-claude-compat

Claude Code compatibility for pi — two independent shims that let Claude Code-origin skills run unmodified:

1. **`CLAUDE_PLUGIN_ROOT` resolution** (`index.ts`) — CC skills reference files and scripts via `${CLAUDE_PLUGIN_ROOT}`, which pi does not set. This shim discovers loaded skills' package roots and transparently rewrites the variable in tool calls to real paths.
2. **`` !`command` `` dynamic placeholders** (`dynamic-skills.ts`) — CC-style dynamic-command placeholders in `SKILL.md` files, executed at invocation time with output inlined before the model sees the prompt, guarded by a strict registered-skills allowlist.

## Install

```bash
pi install npm:@nicknisi/pi-claude-compat
```

No slash commands, tools, keybindings, widgets, or entry types. Both shims are passive event hooks. No configuration.

## `CLAUDE_PLUGIN_ROOT` resolution

Claude Code sets `${CLAUDE_PLUGIN_ROOT}` to the root of the plugin a skill belongs to, and CC skills (ideation, image-gen, etc.) reference files and scripts via that variable. The model writes the variable as it always does, and the extension rewrites it to a real path.

### Hooks

- **`session_start`** — calls `pi.getCommands()`, filters to `source === "skill"`, derives each skill's package root from its `sourceInfo.path`, and collects the unique roots. Sets `process.env.CLAUDE_PLUGIN_ROOT` to the first root, or restores the previous value (usually unset) when there are none.
- **`tool_call`** — rewrites `CLAUDE_PLUGIN_ROOT` references in the `bash` tool's `input.command` and the `read` tool's `input.path` before execution.
- **`session_shutdown`** — clears the roots and restores `CLAUDE_PLUGIN_ROOT` to its previous value, so a stale root never leaks across reloads or session switches.

### Root discovery

Skill paths follow the convention `<package-root>/skills/<skill-name>/SKILL.md`, so the package root is three levels up from the skill file (`SKILL.md` → `<skill-name>/` → `skills/` → `<package-root>/`). All unique roots are kept in memory and rebuilt on every `session_start`.

### Rewriting

The interceptor matches `${CLAUDE_PLUGIN_ROOT}` or `$CLAUDE_PLUGIN_ROOT` (whole word), optionally followed directly by `/path`. For a reference with a path, it tries each known root with `existsSync()` and substitutes the first root where the file exists, falling back to the first root. A bare reference becomes the first root. Parameter-expansion forms such as `${CLAUDE_PLUGIN_ROOT:-default}` and longer names like `$CLAUDE_PLUGIN_ROOTX` are left alone.

```bash
# In a skill ported from Claude Code:
read ${CLAUDE_PLUGIN_ROOT}/references/schema.md
bash ${CLAUDE_PLUGIN_ROOT}/scripts/sync.sh
```

### Caveats

- **Pi internals**: depends on `pi.getCommands()` entries exposing `source === "skill"` and `sourceInfo.path`. If that changes, discovery yields zero roots and the shim becomes a no-op.
- **Heuristic resolution**: with several package roots, a reference resolves to the first root where the file _exists_. Two packages shipping a file at the same relative path can resolve to the wrong one. The fallback for a missing file is the first root in `getCommands()` order.
- **Only `bash` and `read` are intercepted.** References in other tools' inputs (`edit`, `write`, …) are not rewritten.
- **String-level rewrite**: paths containing spaces, semicolons, quotes, or parentheses after the variable are truncated or missed.
- **Mutation of tool input**: relies on pi applying in-place `event.input` mutations from `tool_call` handlers.
- `process.env.CLAUDE_PLUGIN_ROOT` is a single value, so with several packages, shell expansions the interceptor misses resolve to the first package.

## `` !`command` `` dynamic skill placeholders

When a registered skill's `SKILL.md` contains dynamic-command placeholders, the extension runs them as shell commands at invocation time and inlines the output, so skills can embed live context (git state, `gh` output, file listings, …).

### Expansion paths

1. **`/skill:name` invocations** — the `input` handler looks up the skill via `pi.getCommands()`, reads its `SKILL.md`, strips the frontmatter, executes any placeholders, and returns `{ action: "transform", text }` in the same format as pi's built-in expansion: `<skill name="…" location="…">References are relative to <skill dir>.\n\n<body></skill>`, followed by a blank line and the raw args when present. If the body has no placeholders, pi handles the command normally.
2. **Agent `read` of a `SKILL.md`** — the `tool_result` handler rewrites text blocks containing placeholders with command output inlined.

### Security boundary

Commands run **only** for `SKILL.md` files pi registered as skills in the current session. The read path is normalized like pi's read tool (leading `@` stripped, `~` expanded, resolved against the project cwd) and both sides are compared by `realpath`, so symlinked aliases match. Reading any other `SKILL.md` — e.g. from a freshly cloned untrusted repo — never executes anything; the extension posts a `warning` notification (`Skipped !\`cmd\` expansion in unregistered …`) and passes the result through unchanged.

### Placeholder syntax

Mirrors Claude Code:

- **Inline:** `` !`command` `` — only when `!` starts a line or follows whitespace, so `` KEY=!`cmd` `` stays literal.
- **Fenced block:** a fence opened with ` ```! ` for multi-line commands.

### Execution semantics

- Commands run with `cwd` set to the **project directory** (`ctx.cwd`), as in Claude Code.
- All matched commands run in parallel via `child_process.exec`; command output is never re-scanned for nested placeholders.
- Limits: 30 s timeout and 512 KiB buffer per command. Commands are aborted when the current agent turn is cancelled.
- If a command fails with no output, the placeholder becomes ``[!`<first line>` failed: <message>]``. Otherwise stdout (or stderr) is used, trimmed, even on non-zero exit.

### Usage

````markdown
---
name: pr-summary
description: Summarize changes in a pull request
---

- PR diff: !`gh pr diff`
- Changed files: !`gh pr diff --name-only`

```!
gh pr view --json title,body
```

Summarize this pull request.
````

Then invoke:

```
/skill:pr-summary 123
```

An `info` notification (`Expanding dynamic commands in pr-summary…`) is shown while commands run.

### Caveats

- **Pi internals**: relies on `pi.getCommands()` skill metadata and replicates pi's `/skill:` expansion format; if pi changes either, the `/skill:` path can drift from core behavior. The `tool_result` handler assumes `event.content` text blocks and that returning `{ content }` patches the result.
- **Regex edge cases**: a `` !`cmd` `` right after punctuation (e.g. ``(!`cmd`)``) does not execute. Fenced blocks must occupy whole lines.
- **Trust**: commands run via `/bin/sh -c` with your privileges. Treat any registered skill's placeholders as trusted code.

## Dependencies

- Peer: `@earendil-works/pi-coding-agent` — `pi.on(...)`, `pi.getCommands()`, `stripFrontmatter`, `ctx.ui.notify`, `ctx.cwd`, `ctx.signal`.
- Node builtins only. No npm runtime dependencies.
