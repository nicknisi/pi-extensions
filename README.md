# pi-extensions

Nick Nisi's pi extensions — a pnpm monorepo of independently installable [pi](https://github.com/badlogic/pi-mono) packages. Each package under `packages/` is a self-contained pi extension (or shared library) with its own `pi` manifest; install only the ones you want.

## Install

Packages are private (not on npm). Install from a local checkout:

```bash
git clone <this-repo> ~/Developer/pi-extensions
pi install ~/Developer/pi-extensions/packages/statusline   # absolute
pi install ../pi-extensions/packages/btw                   # relative to the settings file
```

Local paths are added to pi's settings without copying — edits in the repo are live on next pi start. Remove with `pi remove <path>`.

## Packages

### Productivity

| Package                              | What it does                                                                                                                                      | Adds                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| [answer](packages/answer/)           | Extracts questions from the last assistant message via a side LLM call, answers them in a tab-through overlay, sends one formatted reply          | `/answer`, `ctrl+.`, Q&A overlay             |
| [btw](packages/btw/)                 | Side-channel LLM chat in a floating window — sees branch context, never touches the main agent's context; promote or fork the thread              | `/btw`, overlay, `btw-answer` entry type     |
| [codemode](packages/codemode/)       | Model-written TypeScript orchestrates subagents compositionally (Promise.all fan-out, pipelines) — executed in-process, returns the module result | `codemode` tool                              |
| [handoff](packages/handoff/)         | Transfers context to a new linked session with a model-generated, editable prompt instead of compacting                                           | `/handoff <goal>`                            |
| [llm-council](packages/llm-council/) | Multiple models answer in parallel as in-process child sessions; a chairman synthesizes                                                           | `llm_council` tool with live inline progress |
| [subagents](packages/subagents/)     | First-party subagent dispatch + fleet: fan out parallel hermetic child agents, inspect live/persisted runs — no pi-subagents dependency           | `dispatch` and `fleet` tools, `/fleet`       |
| [orchestrate](packages/orchestrate/) | `/goal` keeps working until a condition holds; `/loop` re-runs a prompt on a timer                                                                | `/goal`, `/loop`                             |
| [save-md](packages/save-md/)         | Export the latest assistant response to a markdown file                                                                                           | `/save-md <name>`                            |

### UI & appearance

| Package                                      | What it does                                                                                                 | Adds                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| [composer](packages/composer/)               | Config-driven boxed input editor; paste-again-to-expand for collapsed paste markers; tmux focus-aware border | custom editor component                     |
| [header](packages/header/)                   | Animated dashboard header (GIF-compiled truecolor frames or ASCII art) with session info, on fresh sessions  | `/nicknisi-header`, custom header           |
| [mg](packages/mg/)                           | Severance-style "100% File Completion" animation starring a pixelated Michael Grinich, with macOS audio      | `/mg [name]`                                |
| [pin-last-prompt](packages/pin-last-prompt/) | Sticky bar pinning the owning user prompt while scrolled back in fullscreen (pi ≥ 0.84)                      | scrollback overlay bar                      |
| [recap](packages/recap/)                     | LLM "where was I" card injected into the transcript after idle minutes                                       | `/recap`, `/recap-idle`, `recap` entry type |
| [spinner](packages/spinner/)                 | ~1000 rotating joke/meme phrases for the working spinner                                                     | —                                           |
| [statusline](packages/statusline/)           | Footer: model, cost, context bar, lines changed, usage limits, git PR link; writes tmux status files         | custom footer, `~/.cache/pi-status/`        |
| [turn-timer](packages/turn-timer/)           | Dim per-turn elapsed-time row below each response                                                            | `turn-duration` entry type                  |

### Behavior & plumbing

| Package                                  | What it does                                                                                                                 | Adds                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| [agent-urls](packages/agent-urls/)       | `agent://` / `history://` URIs for pi-subagents runs; list and read run outputs/transcripts                                  | `/agent`, `list_agent_runs`, `read_agent_url` tools |
| [artifacts](packages/artifacts/)         | `artifact` tool: render markdown/HTML to styled browser pages from a lazy localhost server, with live reload                 | `artifact` tool, `/artifacts`                       |
| [auto-theme](packages/auto-theme/)       | Sync pi theme with macOS system appearance (dark↔light pairs)                                                                | —                                                   |
| [claude-compat](packages/claude-compat/) | Claude Code compatibility: `CLAUDE_PLUGIN_ROOT` path shimming + `` !`command` `` dynamic SKILL.md placeholders (allowlisted) | two extension entry points                          |
| [cloak](packages/cloak/)                 | Redact secrets from `read` tool results before they reach model context, via glob-scoped regex rules                         | `/cloak-status`, `cloak.json`                       |
| [session-name](packages/session-name/)   | Auto-name sessions (heuristic or LLM), mirror to terminal title, name-focused session picker                                 | `/sn`, `/sessions`                                  |
| [stash](packages/stash/)                 | `ctrl+s` parks the prompt draft on a LIFO stack; pop or auto-restore                                                         | `ctrl+s`, stash widget                              |

### Library

| Package                    | What it does                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [shared](packages/shared/) | `@nicknisi/pi-shared` — helper library (not an extension): `getModelProvider` for one-off LLM calls, TUI utilities (gradient text, tree section removal, two-column layout, escape sanitization, render dispatcher), `SearchableSelectList`, the in-process subagent runtime (`createSubagentRuntime`), and the declarative workflow engine (`runWorkflow`). Consumed via `workspace:*` by 7 packages. |

## Development

```bash
pnpm install
pnpm typecheck   # tsgo (TypeScript 7 native preview)
pnpm build       # compile each package to packages/<name>/dist/
pnpm lint        # oxlint
pnpm fmt         # oxfmt
```

Layout: one directory per package in `packages/`, each with `index.ts` + `package.json` carrying a `pi` manifest (`"pi": { "extensions": ["./index.ts"] }`). `@earendil-works/*` packages are peer dependencies: pi's runtime aliases them to its own modules at load time, and the root devDependencies provide one canonical copy for typechecking (`autoInstallPeers: false` keeps it that way).

### Two entry points per package

Each package publishes its TypeScript sources _and_ compiled JS, and they are used by different consumers:

| Field           | Points at                               | Used by                                            |
| --------------- | --------------------------------------- | -------------------------------------------------- |
| `pi.extensions` | `./index.ts`                            | pi, which transpiles extensions through jiti       |
| `exports`       | `./dist/index.js` + `./dist/index.d.ts` | everyone else — bundlers, and anything `tsc`-built |

The split exists because Node refuses to strip types inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so a `tsc`-built consumer importing raw `.ts` from a package crashes at runtime. Keeping `pi.extensions` on the sources means local path installs (`pi install ../pi-extensions/packages/statusline`) still need no build step, which is the point of the rapid-testing loop.

Consequences worth knowing:

- **`dist/` is git-ignored**, so `pnpm build` runs in CI before publish (see `release.yml`) and from the root `prepare` script after `pnpm install`. That hook is load-bearing for local path installs: six packages depend on `@nicknisi/pi-shared`, which now resolves through its own `exports` into `dist/`, so a fresh clone with no build would fail to load them in pi. If you ever delete `dist/` by hand, run `pnpm build` — a no-op `pnpm install` will not re-run `prepare`.
- **Relative imports use `.js`, never `.ts`** (`import { x } from './config.js'`), the normal NodeNext convention — `allowImportingTsExtensions` is deliberately off so the typecheck catches any regression.
- **`paths` in the root tsconfig** maps `@nicknisi/pi-shared` to its source, so a fresh clone typechecks without building first. The build turns that off (`paths: {}`) and resolves siblings through their real `exports` instead, which is what proves the declaration output is actually usable.

Cross-package helpers go in `packages/shared`, consumed as `"@nicknisi/pi-shared": "workspace:*"`.

## Notes

- Runtime configs live outside the repo: `~/.pi/agent/configs/<name>.json` for most packages. Example configs ship with the packages that need them.
- Several extensions lean on pi internals (component tree shapes, editor privates, fullscreen renderer state) — each README's caveats section calls these out; a pi upgrade can break them.
- macOS-centric: auto-theme, statusline's tmux integration, and btw's fork-to-window all assume macOS/tmux/ghostty.
