# llm-council

An LLM Council tool for pi: multiple models answer the same question independently, in parallel, as in-process child agent sessions (via `@nicknisi/pi-shared`'s subagent runtime), then a chairman model synthesizes their (anonymized) answers into one unified response. Useful for questions that benefit from multiple perspectives or cross-checking — divergent answers flag uncertainty. Not for simple factual questions or routine tasks. Progress streams inline in the tool result with animated spinners, per-member status, cumulative token usage, and elapsed times; expanding the result shows the full markdown of every member response plus the chairman's synthesis.

## Install

```sh
pi install /Users/nicknisi/Developer/pi-extensions/packages/llm-council
```

## What it adds

- **Tool:** `llm_council` (label "LLM Council"), with optional per-call `models` and `chairman` overrides.
- **Command:** `/council <question>` runs immediately with the current conversation as context. Bare `/council` asks for a question and runs on Enter. `/council settings` edits the lineup without running. `/council reset` returns this session to configured defaults.
- **Command results:** `llm-council-result` messages display the synthesis in chat and keep it available to subsequent turns. Expand the result for individual responses and errors.
- **Session state:** `llm-council-selection` custom entries remember the lineup and thinking levels across reloads, resumes, forks, and branch navigation. These entries are not sent to the LLM. A footer status shows the session's selected lineup.
- Custom `renderCall` / `renderResult` for the tool: live member/chairman tree with spinner, status icons, elapsed times, and an expanded view rendering full member + chairman markdown. Expand/collapse uses the standard `app.tools.expand` keybinding (default `ctrl+o`).

### Tool parameters

| Parameter  | Type                 | Description                                                                      |
| ---------- | -------------------- | -------------------------------------------------------------------------------- |
| `question` | `string`             | The question to pose to the council                                              |
| `models`   | `string[]`, optional | Replace the members for this call only. At least one distinct model is required. |
| `chairman` | `string`, optional   | Replace the chairman for this call only.                                         |

Use exact `provider/model` IDs or unambiguous names. Qualified IDs must match exactly, so a missing model is never silently replaced by a newer variant. Ambiguous references open a provider/model selection dialog in interactive or RPC mode. Headless calls return an error listing the matches. Unknown models, duplicate members, and cancelled selections fail before any member starts. Per-call overrides never change session or global defaults.

Prompt guidance registered with the tool tells the agent to use it for complex questions that benefit from multiple perspectives, and not for simple factual questions.

## How it works

1. **Members** — each council member receives the same question and answers independently, in parallel (`Promise.all`). Each runs as a hermetic in-process child session spawned through pi's SDK (`createAgentSession`), shared via `@nicknisi/pi-shared`'s `createSubagentRuntime`; the answer is the child's final assistant message.
2. **Chairman** — receives the question plus all successful member answers (labeled Member A/B/C) and synthesizes a unified answer. If `chairman.exposePersonas` is `true`, each member's system prompt is included as `(persona: "...")`. The chairman's text is the tool's final content.
3. If every member fails, the tool returns an error result; the chairman never runs. If the chairman fails, its error is returned and any partial synthesis is labeled incomplete.

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

Run `/council <question>` to start immediately with the current lineup. Bare `/council` opens one question field with the members and synthesizer shown underneath. Enter runs the council without another confirmation. Progress appears while the members work, followed by the synthesized answer in chat. Escape cancels the question prompt or aborts a running council.

The command sends the current branch's conversation context to every member and the synthesizer. Compaction summaries are included, rather than discarded history or other branches. Pi's text serializer shortens tool outputs and omits image data. No extra summarization call is made. Very long context can still exceed a selected model's context window.

Runs reuse the selected or configured lineup without changing it or switching the main chat model. Missing or ambiguous models must be resolved before any member starts. Use `/council settings` to edit the lineup without running models.

Open **Members** to edit a searchable checklist. Every model available through your configured providers is searchable immediately, regardless of the session's model scope. Selected models appear first with `[x]`, followed by scoped models and the rest of the catalog. Type a model name, provider, or exact ID to filter. Space toggles the highlighted member, even while searching. Enter keeps your choices and returns to settings. Escape returns without changing the checklist's original selection.

Open **Synthesizer** to choose the model that combines the member answers, called `chairman` in tool arguments and config. It can also be a member. Type to search and press Enter to choose it. Both lists show readable names and providers, with the highlighted model's full ID below the list. Missing or ambiguous configured selections stay visible so you can replace or remove them.

Member and synthesizer thinking levels can be changed separately. `default` uses Pi's default. Pi adjusts thinking to each model's capabilities when it runs.

In `/council settings`, **Save lineup** saves the draft for this session without running models. **Save as global default** asks for confirmation, updates the global config while preserving unrelated settings and existing member personas, then applies the lineup to this session. Escape from settings discards the draft. A council must have at least one member. These commands require TUI mode while the agent is idle.

You can still ask a question normally in chat, for example:

```
Which approach is better for X: A or B? Convene the council.
```

Or target models for one question: "Ask Fable 5.1 and Astra to compare these two designs, with Fable as chairman." The agent supplies the tool overrides. Exact IDs avoid ambiguity:

```json
{
  "question": "Compare these two designs.",
  "models": ["anthropic/claude-fable-5-1", "openai-codex/gpt-6-astra"],
  "chairman": "anthropic/claude-fable-5-1"
}
```

Model availability depends on your Pi catalog and provider credentials. Catalog presence does not verify that a token is still valid. Use `/login` to reconnect a provider if a call fails authentication.

Or steer it directly: "use llm_council to compare these two designs". The tool result shows the chairman's synthesis; press the tools-expand key (`ctrl+o`) on the tool block to see every member's full response.

## Configuration

Lineup precedence is **per-call overrides > session selection > project config > global config > built-in defaults**. `/council reset` removes the session selection. A global save does not overwrite project overrides or other sessions' saved selections.

Two config files:

1. **Global:** `~/.pi/agent/configs/llm-council.json` — copy [`llm-council.example.json`](llm-council.example.json). Execution settings reload per call. Display settings load once at module load, and this is the only source for `shared` settings. The path follows pi's agent dir, so it moves with `PI_CODING_AGENT_DIR` if you set it.
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
| `display.icon`       | `string`           | `""`                          | Icon prefix before the "Synthesizer" label                         |
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
- Global and project execution settings are re-read on every tool call. Display changes still require `/reload` or a restart. Session selections override model and thinking settings until `/council reset`.
- Members and chairman run with the current working directory as `cwd`; `contextFiles: false` keeps CLAUDE.md/AGENTS.md out of member context by default.
