# llm-council

An LLM Council tool for pi: multiple models answer the same question independently, in parallel, as in-process child agent sessions (via `@nicknisi/pi-shared`'s subagent runtime), then a chairman model synthesizes their (anonymized) answers into one unified response. Useful for questions that benefit from multiple perspectives or cross-checking — divergent answers flag uncertainty. Not for simple factual questions or routine tasks. Progress streams inline in the tool result with animated spinners, per-member status, cumulative token usage, and elapsed times; expanding the result shows the full markdown of every member response plus the chairman's synthesis.

## Install

```sh
pi install /Users/nicknisi/Developer/pi-extensions/packages/llm-council
```

## What it adds

- **Tool:** `llm_council` (label "LLM Council"). No slash commands, no keybindings, no overlays/widgets, no events, no custom entry types.
- Custom `renderCall` / `renderResult` for the tool: live member/chairman tree with spinner, status icons, elapsed times, and an expanded view rendering full member + chairman markdown. Expand/collapse uses the standard `app.tools.expand` keybinding (default `ctrl+o`).

### Tool parameters

| Parameter  | Type     | Description                         |
| ---------- | -------- | ----------------------------------- |
| `question` | `string` | The question to pose to the council |

Prompt guidance registered with the tool tells the agent to use it for complex questions that benefit from multiple perspectives, and not for simple factual questions.

## How it works

1. **Members** — each council member receives the same question and answers independently, in parallel (`Promise.all`). Each runs as a hermetic in-process child session spawned through pi's SDK (`createAgentSession`), shared via `@nicknisi/pi-shared`'s `createSubagentRuntime`; the answer is the child's final assistant message.
2. **Chairman** — receives the question plus all successful member answers (labeled Member A/B/C) and synthesizes a unified answer. If `chairman.exposePersonas` is `true`, each member's system prompt is included as `(persona: "...")`. The chairman's text is the tool's final content.
3. If every member fails, the tool returns an error result; the chairman never runs. If the chairman fails, its error text is returned.

### Exec config → spawn options

The `tools` / `thinking` / `extensions` / `skills` / `contextFiles` options on `member` and `chairman` map onto the shared runtime's spawn options:

| Option         | Value       | Effect                                                                            |
| -------------- | ----------- | --------------------------------------------------------------------------------- |
| `tools`        | `null`/`[]` | No tools                                                                          |
| `tools`        | `[...]`     | Exactly those built-in tools (allowlist)                                          |
| `thinking`     | `null`      | _(pi default)_                                                                    |
| `thinking`     | `"..."`     | Thinking level (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`)              |
| `extensions`   | `null`/`[]` | _(none — children are hermetic)_                                                  |
| `extensions`   | `[name]`    | Load `~/.pi/agent/extensions/<name>/src/index.ts` (per name, containment-checked) |
| `skills`       | `null`/`[]` | _(none — children are hermetic)_                                                  |
| `skills`       | `[name]`    | Load `~/.pi/agent/skills/<name>/SKILL.md` (per name, containment-checked)         |
| `contextFiles` | `false`     | No AGENTS.md / project context files                                              |
| `contextFiles` | `true`      | Context files load                                                                |

> **Behavior change from the subprocess era:** `extensions: null` / `skills: null` used to mean "inherit pi defaults" (ambient extensions/skills loaded into the child). Children are now hermetic by construction — `null` and `[]` both mean _none_; only explicitly named resources load.

System prompts are appended to pi's default system prompt through the child's resource loader (no temp files). The runtime honors the ecosystem recursion guard: when `PI_SUBAGENT_DEPTH`/`PI_SUBAGENT_CHILD` are set (i.e. the council itself is running inside a pi-subagents child), spawns are refused with a typed `crashed` result.

## Default council

The built-in lineup assumes models enabled in `~/.pi/agent/settings.json` `enabledModels`:

| Role     | Model                                         | Label    |
| -------- | --------------------------------------------- | -------- |
| Member   | `fireworks/accounts/fireworks/models/glm-5p2` | Member A |
| Member   | `fireworks/accounts/fireworks/models/kimi-k3` | Member B |
| Member   | `anthropic/claude-fable-5`                    | Member C |
| Chairman | `anthropic/claude-opus-5`                     | Chairman |

Members run with read-only built-in tools (`read`, `grep`, `find`, `ls`), no extensions, no skills, `thinking: medium`, and no project context files. The chairman has no tools — it only synthesizes.

## Usage

No command to run yourself — ask in a pi session and the agent decides when to convene the council, e.g.:

```
Which approach is better for X: A or B? Convene the council.
```

Or steer it directly: "use llm_council to compare these two designs". The tool result shows the chairman's synthesis; press the tools-expand key (`ctrl+o`) on the tool block to see every member's full response.

## Configuration

Two layers:

1. **Global:** `~/.pi/agent/configs/llm-council.json` — copy [`llm-council.example.json`](llm-council.example.json). Loaded once at module load; this is the only source for `shared` (display) settings. The path follows pi's agent dir, so it moves with `PI_CODING_AGENT_DIR` if you set it.
2. **Project-local:** `<cwd>/.pi/configs/llm-council.json` — copy [`llm-council.project.example.json`](llm-council.project.example.json). Deep-merged over the global file per tool call, so only differing keys are needed — typically `member.council` and `chairman.model` to give a work project a different lineup. Display (`shared`) settings do **not** apply from the project file.

No environment variables are read for configuration. (`PI_SUBAGENT_DEPTH` is set internally to block recursion.)

### `member`

| Key                   | Type               | Default                       | Description                                                                                                       |
| --------------------- | ------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `council`             | `object[]`         | _(3 members, above)_          | Each entry: `model` (required), `label` (default: `"1"`, `"2"`, …), `displayName`, `systemPrompt` (both optional) |
| `defaultSystemPrompt` | `string`           | _(built-in; see `config.ts`)_ | System prompt for members without their own. The built-in default forbids spawning subprocesses                   |
| `display.labelColor`  | `string`           | `"accent"`                    | Member label color                                                                                                |
| `display.modelColor`  | `string`           | `"dim"`                       | Model name color                                                                                                  |
| `tools`               | `string[] \| null` | `["read","grep","find","ls"]` | Tool allowlist for member child sessions (`null`/`[]` → no tools)                                                 |
| `thinking`            | `string \| null`   | `"medium"`                    | Thinking level (`null` → pi default)                                                                              |
| `extensions`          | `string[] \| null` | `[]`                          | Extension names, resolved to `~/.pi/agent/extensions/<name>/src/index.ts` (`null` → pi defaults)                  |
| `skills`              | `string[] \| null` | `[]`                          | Skill names, resolved to `~/.pi/agent/skills/<name>/SKILL.md` (`null` → pi defaults)                              |
| `contextFiles`        | `boolean`          | `false`                       | `false` → `--no-context-files`                                                                                    |

### `chairman`

| Key                  | Type               | Default                       | Description                                                        |
| -------------------- | ------------------ | ----------------------------- | ------------------------------------------------------------------ |
| `model`              | `string`           | `"anthropic/claude-opus-5"`   | Chairman model                                                     |
| `displayName`        | `string`           | `"Claude Opus 5"`             | Human-readable name shown in the UI                                |
| `systemPrompt`       | `string`           | _(built-in; see `config.ts`)_ | Chairman system prompt (treats member answers as anonymous)        |
| `exposePersonas`     | `boolean`          | `true`                        | Include each member's system prompt as a persona in chairman input |
| `display.icon`       | `string`           | `""`                          | Icon prefix before the "Chairman" label                            |
| `display.labelColor` | `string`           | `"accent"`                    | Chairman label color                                               |
| `display.modelColor` | `string`           | `"dim"`                       | Chairman model name color                                          |
| `tools`              | `string[] \| null` | `[]`                          | Chairman tool allowlist (none by default)                          |
| `thinking`           | `string \| null`   | `"medium"`                    | Thinking level                                                     |
| `extensions`         | `string[] \| null` | `[]`                          | Extensions (`null` → pi defaults)                                  |
| `skills`             | `string[] \| null` | `[]`                          | Skills (`null` → pi defaults)                                      |
| `contextFiles`       | `boolean`          | `false`                       | Context files for chairman                                         |

### `shared` (display — global config only)

| Key                                     | Default                     | Description                                  |
| --------------------------------------- | --------------------------- | -------------------------------------------- |
| `spinner.prefixChars`                   | `["·","✢","✳","✶","✻","✽"]` | Spinner frames (played forward then reverse) |
| `spinner.interval`                      | `80`                        | Frame interval, ms                           |
| `spinner.color`                         | `"muted"`                   | Spinner color                                |
| `successPrefix.prefix`/`color`          | `"✓"` / `"success"`         | Success icon                                 |
| `errorPrefix.prefix`/`color`            | `"✗"` / `"error"`           | Error icon                                   |
| `branch.prefix`/`color`                 | `"└─"` / `"separator"`      | Sub-line branch prefix                       |
| `status.doneLabel`/`doneColor`          | `"Done"` / `"success"`      | Completed-status label/color                 |
| `status.errorLabel`/`errorColor`        | `"Error"` / `"error"`       | Error-status label/color                     |
| `status.workingLabel`/`workingColor`    | `"Working..."` / `"dim"`    | In-progress label/color                      |
| `status.waitingIcon`/`waitingIconColor` | `"↪"` / `"muted"`           | Pending member icon/color                    |
| `status.synthesizingLabel`              | `"Synthesising..."`         | Chairman in-progress label                   |
| `status.waitingLabel`                   | `"Waiting for members..."`  | Chairman pending label                       |
| `status.elapsedColor`                   | `"dim"`                     | Elapsed-time color                           |
| `toolHeader.titleColor`/`summaryColor`  | `"toolTitle"` / `"dim"`     | Tool call header colors                      |
| `expandHint.color`                      | `"dim"`                     | "ctrl+o to expand" hint color                |
| `questionPreview.maxLength`             | `40`                        | Chars of the question shown in the header    |

### Color values

Any color field accepts a pi theme token (`"text"`, `"accent"`, `"success"`, `"error"`, `"muted"`, `"dim"`, `"separator"`, `"toolTitle"`, …) or a 6-digit hex string (`"#ff6600"`, rendered as a 24-bit ANSI fg). Unknown tokens fall back to uncolored text.

## Dependencies

- `@earendil-works/pi-coding-agent` (peer) — `ExtensionAPI` (`pi.registerTool`), `Theme`/`ThemeColor`, `getMarkdownTheme`.
- `@earendil-works/pi-tui` (peer) — `Markdown` and `Text` render components, `getKeybindings` (for the expand-hint key label).
- `typebox` — tool parameter schema (`Type.Object`).
- `@nicknisi/pi-shared` (workspace) — the in-process subagent runtime (`createSubagentRuntime`) that members and the chairman spawn through.
- No `pi` binary requirement: children are in-process SDK sessions, not subprocesses.

## Caveats

- **Extension resolution path is hardcoded.** `extensions: ["name"]` resolves to `~/.pi/agent/extensions/<name>/src/index.ts` — only directory-style extensions with that layout work. Single-file `.ts` extensions and npm-package extensions don't match; the code comments recommend keeping `extensions: []` for members. Same for `skills` → `~/.pi/agent/skills/<name>/SKILL.md`.
- **Depends on pi's SDK surface:** `createAgentSession`, `DefaultResourceLoader` (its `noExtensions`/`additionalExtensionPaths` semantics), `SessionManager.inMemory`, `SettingsManager.inMemory`, `ModelRuntime`/`resolveCliModel`. These are pi internals that could change across versions; the runtime is version-matched at runtime because pi aliases `@earendil-works/*` imports to the host, but type-level drift would surface at extension load.
- **Pi internals:** the spinner relies on the `renderCall`/`renderResult` `ctx.state` bag and `ctx.invalidate()`. A module-level `liveDetails` bridges `onUpdate` → `renderCall` as a workaround for an `isPartial` bug (per code comment); only one council can render live at a time.
- **Recursion guard:** the shared runtime refuses to spawn when `PI_SUBAGENT_DEPTH`/`PI_SUBAGENT_CHILD` are set — this tool won't work if invoked from inside a pi-subagents child session.
- Global config is read **once at module load** — edits to `~/.pi/agent/configs/llm-council.json` require a pi restart; project-local config is re-read on every tool call.
- Members and chairman run with the current working directory as `cwd`; `contextFiles: false` keeps CLAUDE.md/AGENTS.md out of member context by default.
