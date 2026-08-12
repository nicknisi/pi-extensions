# @nicknisi/pi-answer

Extracts unanswered questions from the last completed assistant message and presents them in an interactive Q&A overlay, then sends your answers back into the session as a single formatted user message. It exists for the common case where the agent ends a turn with several questions scattered through its output — instead of re-reading and composing a reply by hand, you tab through a focused form and fire the answers back in one shot.

## What it adds

- **Slash command:** `/answer`
- **Keybinding (shortcut):** `ctrl+.` — same handler as the command
- **Overlays (via `ctx.ui.custom`):**
  - A `BorderedLoader` while questions are being extracted by an LLM (abortable with Esc)
  - An `AnswerComponent` — a bordered, multi-question form with navigation, per-question status, and a submit confirmation step
- No tools, no widgets, no custom message/entry types. The submitted answers go out as a regular user message via `pi.sendUserMessage`.

## How it works

1. Walks `ctx.sessionManager.getBranch()` backwards to find the last assistant message with `stopReason === "stop"` and non-empty text. Incomplete (e.g. aborted or tool-loop) assistant messages are skipped, with a warning if any were skipped.
2. Sends that message's text to an extraction model with a system prompt instructing it to return `{"questions": [{question, context?}]}` JSON — only questions that require user input, each self-contained.
3. Parses the response leniently: tries the raw text, ` ```json ` fenced blocks, and the first `{`..`}` span. If parsing fails or the response is empty, falls back to a regex-based extractor that pulls `?`-terminated sentences out of the original message. Questions are trimmed and case-insensitively deduped.
4. Opens the answer form. On submit, builds a message:

   ```text
   Here are my answers to your questions:

   Q: <question>
   Context: <context, if any>
   A: <answer, or "(no answer)">
   ```

5. If the session is idle (`ctx.isIdle()`), sends via `pi.sendUserMessage(answers)`. If the agent is still running, sends with `{ deliverAs: "followUp" }` and notifies that it was queued.

## Usage

```text
/answer
```

or press `ctrl+.` at the prompt.

### Answer form keybindings

| Key                             | Action                                                             |
| ------------------------------- | ------------------------------------------------------------------ |
| `Tab` / `Enter`                 | Next question (on the last question: show submit confirmation)     |
| `Shift+Tab`                     | Previous question                                                  |
| `Shift+Enter`                   | Newline inside the current answer                                  |
| `Up` / `Down`                   | Previous/next question (only when the current answer box is empty) |
| `Esc` / `Ctrl+C`                | Cancel (in confirmation: go back to the form)                      |
| `Enter` / `y` (in confirmation) | Submit all answers                                                 |
| `n` (in confirmation)           | Go back to the form                                                |

The form renders up to 120 columns wide and shows: question counter `(n/N)`, answered count, a per-question status strip (current highlighted, answered in success color, unanswered dim), the question text with optional `Context:` line, and the answer editor. Unanswered questions submit as `(no answer)` — the confirmation step tells you how many.

The extraction loader can be aborted with Esc, which cancels the whole flow.

## Configuration

Optional global config: `~/.pi/agent/configs/answer.json`. Changes take effect on the next session or after `/reload`.

```json
{
  "extractionModels": ["anthropic/claude-fable-5", "anthropic/claude-opus-5"]
}
```

`extractionModels` is a non-empty ordered list of `provider/model-id` strings. The first model that both exists in `ctx.modelRegistry` and passes `getApiKeyAndHeaders()` is used. Model IDs may contain additional slashes; only the first slash separates the provider. Missing or invalid config falls back to the list above and invalid config emits a warning. See [`answer.example.json`](./answer.example.json).

The current session model (`ctx.model`) is **not** used for extraction—only checked for presence as a guard. API keys come from Pi's normal model authentication.

## Dependencies

- `@earendil-works/pi-coding-agent` — `ExtensionAPI`, `ExtensionContext`, `BorderedLoader`, `Theme`
- `@earendil-works/pi-tui` — `Component`, `Focusable`, `Editor`, `EditorTheme`, `Key`, `matchesKey`, `TUI`, `truncateToWidth`, `visibleWidth`, `wrapTextWithAnsi`
- `@earendil-works/pi-ai` — types only (`Api`, `Model`, `UserMessage`)
- `@nicknisi/pi-shared` (workspace) — `getModelProvider(ctx, model)`, which resolves the composed runtime provider from `ctx.modelRegistry.getProvider()` (honors models.json overrides and extension-registered providers, unlike compat dispatch)

No third-party npm dependencies.

## Caveats

- **Extraction-model availability.** If none of the configured candidates exist with working authentication, the command errors out listing every model it checked.
- **Pi internals:** depends on `ctx.sessionManager.getBranch()` entry shapes (`entry.type === "message"`, `message.role`, `message.stopReason === "stop"`, content part `{ type: "text", text }`), `ctx.modelRegistry.find/getApiKeyAndHeaders/getProvider`, `ctx.ui.custom` component contract, and `pi.sendUserMessage(..., { deliverAs: "followUp" })`. Any of these changing across pi versions will break it.
- **Editor render slicing.** `AnswerComponent.render` strips the first and last lines of the embedded `Editor.render()` output (`editorLines[1..len-2]`) assuming the Editor wraps its content in a border frame. If pi-tui's `Editor` render shape changes, answers will render wrong.
- **Extraction is heuristic at the edges.** The LLM prompt tries to keep questions self-contained, but the regex fallback (`fallbackExtractQuestions`) is naive — it splits on sentence boundaries ending in `?` and can produce context-free or false-positive questions when extraction JSON parsing fails.
- **Multi-part assistant messages** are flattened by joining all text parts with `\n`; non-text parts (tool calls, thinking) are ignored.
- Requires interactive UI (`ctx.hasUI`); errors out in headless mode.

## Install

```bash
pi install /Users/nicknisi/Developer/pi-extensions/packages/answer
```
