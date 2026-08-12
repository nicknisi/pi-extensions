# @nicknisi/pi-btw

Side-channel LLM chat in a floating window. `/btw <question>` opens an overlay backed by a configurable one-off `streamSimple` thread that sees the current branch's conversation context plus your questions. Answers stream live into the window, follow-ups can be typed in place, and the thread never touches the main agent's context no matter how deep it goes. On close, the thread persists as a custom session entry that renders in the transcript but never enters LLM context or triggers a turn.

Use it for the "quick question while the agent works" case: explanations, alternatives, sanity checks — without polluting the main conversation or spending a steer/follow-up turn on it.

## What it adds

| Surface                    | Name                              | Notes                                                                                      |
| -------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| Slash command              | `/btw <question>`                 | Uses the model configured in `~/.pi/agent/configs/btw.json`                                |
| Overlay window             | `BtwWindow` via `ctx.ui.custom()` | Streaming markdown thread + follow-up editor                                               |
| Custom entry type          | `btw-answer`                      | Persisted via `pi.appendEntry()`, rendered by `pi.registerEntryRenderer()`                 |
| Legacy custom message type | `btw-answer`                      | Old sessions stored answers as custom messages; still rendered and filtered out of context |
| Event hook                 | `context`                         | Filters legacy `btw-answer` custom messages out of the LLM context                         |
| Env var                    | `PI_BTW_SPLIT`                    | `h` or `v` to force tmux split direction on fork                                           |

No keybindings are registered globally; all keys below are handled by the overlay itself.

## Usage

```
/btw why is this test flaky?
```

The window opens immediately and streams the answer. While idle (not streaming):

| Key              | Action                                                        |
| ---------------- | ------------------------------------------------------------- |
| `enter`          | Send a follow-up question                                     |
| `esc` / `ctrl+c` | Close the window; thread persists as a transcript card        |
| `ctrl+p`         | Promote: close and hand the thread to the main agent          |
| `ctrl+f`         | Fork: write branch + thread to a new session file and open it |
| `up` / `down`    | Scroll (when the editor is empty)                             |

While streaming:

| Key              | Action                                                                          |
| ---------------- | ------------------------------------------------------------------------------- |
| `esc` / `ctrl+c` | Cancel the in-flight answer; the question is restored into the editor for retry |
| `up` / `down`    | Scroll                                                                          |

### Promote (`ctrl+p`)

Closes the window and sends the thread to the main agent as a user message:

```
FYI — I had this side conversation with <model> (via /btw). Factor it into what you're doing where relevant:

Q: ...
A: ...
```

If the agent is mid-turn it is delivered as a steer message (`deliverAs: "steer"`); otherwise as a normal follow-up.

### Fork (`ctrl+f`)

Writes the current branch plus the btw thread (as real user/assistant messages) to a **new** session file in the session directory, leaving the live session untouched. The forked session is named `btw: <first question>` and records `parentSession` pointing at the live session file. It is then opened on the best available surface:

1. **tmux split** — if `$TMUX` is set. Direction is `-h` when the pane is ≥ 160 columns wide, otherwise `-v`; override with `PI_BTW_SPLIT=h|v`.
2. **New Ghostty window** (macOS) — via `open -na Ghostty --args --working-directory=<cwd> -e /bin/zsh -ilc 'exec pi --session ...'`. Runs through a login+interactive zsh because GUI apps launched by `open` only inherit launchd's minimal `PATH`, which typically lacks `pi`.
3. **Clipboard + printed command** — `pi --session <file>` copied via `pbcopy` (macOS only) and shown in a notification.

Fork happens _before_ the transcript card is persisted, so the forked session does not contain the card entry.

## How it works

- On `/btw`, the current branch (`ctx.sessionManager.getBranch()`) is converted to LLM messages with `convertToLlm()`. Assistant tool calls with no matching `toolResult` are dropped first, because `/btw` can run mid-turn when tool calls are still unanswered, and Anthropic rejects `tool_use` blocks without a matching `tool_result`.
- The side thread starts from that snapshot. Each question is sent to the configured model with a fixed system prompt (concise, no tool suggestions) via `getModelProvider(ctx, model).streamSimple(...)`, with `apiKey`/`headers` from `ctx.modelRegistry.getApiKeyAndHeaders()` and the current thinking level (`off` maps to `undefined`). Completed Q&A pairs are appended to the side thread, so follow-ups have full side-thread history plus the original branch snapshot.
- The overlay is a `Component`/`Focusable` from `@earendil-works/pi-tui`, rendering a bordered box (max width 100, body capped at 30 rows or `terminal.rows - 14`) with a spinner while streaming and markdown-rendered answers.
- On close with at least one completed turn, the thread is persisted via `pi.appendEntry<BtwEntryData>("btw-answer", { model, turns })`.

### Why custom entries instead of `pi.sendMessage()`

Custom messages participate in LLM context and, when sent while the agent is streaming, are delivered as steer messages — which continues the agent loop with an extra LLM call. The extension's own context filter would then strip the btw message, leaving the conversation ending on an assistant message, which models that reject assistant prefill 400 on. Custom entries render in the transcript but never enter context or trigger a turn by design. The `context` event hook and `registerMessageRenderer` exist only to support legacy sessions that predate the entry-based approach.

## Configuration

Optional global config: `~/.pi/agent/configs/btw.json`. Changes take effect on the next session or after `/reload`.

```json
{
  "model": "fireworks/glm-latest"
}
```

`model` must be a `provider/model-id` string registered in Pi with working authentication. Model IDs may contain additional slashes; only the first slash separates the provider. Missing or invalid config falls back to `fireworks/glm-latest` and invalid config emits a warning. See [`btw.example.json`](./btw.example.json).

| Variable       | Values   | Default                                                                  |
| -------------- | -------- | ------------------------------------------------------------------------ |
| `PI_BTW_SPLIT` | `h`, `v` | unset — split direction chosen from pane width (≥ 160 cols → horizontal) |

`$TMUX` (set by tmux itself) is checked to decide the fork-open surface.

## Dependencies

Runtime (workspace):

- `@nicknisi/pi-shared` — `getModelProvider(ctx, model)`, which resolves the composed runtime provider from `ctx.modelRegistry.getProvider()` (honoring `models.json` overrides and extension-registered providers).

Peer (pi APIs):

- `@earendil-works/pi-ai` — `Message`, `AssistantMessage`, `ThinkingLevel` types.
- `@earendil-works/pi-coding-agent` — `ExtensionAPI`, `SessionEntry`, `Theme`, `convertToLlm`, `CURRENT_SESSION_VERSION`, `getMarkdownTheme`; extension surface used: `pi.registerCommand`, `pi.on("context")`, `pi.registerMessageRenderer`, `pi.registerEntryRenderer`, `pi.appendEntry`, `pi.sendUserMessage`, `pi.getThinkingLevel`, `ctx.ui.custom`, `ctx.ui.notify`, `ctx.sessionManager`, `ctx.modelRegistry`, `ctx.model`, `ctx.isIdle()`.
- `@earendil-works/pi-tui` — `Box`, `Component`, `Editor`, `Focusable`, `Key`, `Markdown`, `Text`, `matchesKey`, `truncateToWidth`, `visibleWidth`, `wrapTextWithAnsi`.

Node builtins: `child_process` (tmux/Ghostty/pbcopy), `crypto` (entry/session ids), `fs`, `path` (fork session file).

## Caveats

- **Fork mirrors `SessionManager` internals.** `forkSessionWithThread()` reimplements what `SessionManager.createBranchedSession` does (minus the switch-in-place): it writes the jsonl session format directly, pinned to `CURRENT_SESSION_VERSION`. A session-format change in pi will break forks until this is updated.
- **Label entries are dropped** in forked sessions, because labels may parent other entries and would break the re-chained `parentId` links.
- **Theme keys relied on:** `accent`, `dim`, `muted`, `warning`, `success`, `error`, `border`, `borderAccent`, `customMessageBg`. A theme missing these will degrade rendering.
- **Terminal size heuristic:** body height is `min(rows - 14, 30)`; on very small terminals the window may still crowd the screen.
- **macOS-only fallbacks:** Ghostty window opening and `pbcopy` are darwin-only; on other platforms fork falls back to printing the `pi --session` command.
- **Ghostty PATH workaround** depends on `pi` being on the `PATH` of a login+interactive zsh (`zsh -ilc`). If your shell init doesn't put `pi` on `PATH`, the Ghostty fork window will fail.
- **Mid-turn tool calls:** context snapshot silently drops unanswered tool calls, so the side assistant doesn't see in-flight tool invocations.
- Entry ids in forked sessions are 4-byte random hex; collision-checked against existing ids.

## Install

```
pi install /Users/nicknisi/Developer/pi-extensions/packages/btw
```
