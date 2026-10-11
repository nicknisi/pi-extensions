# @nicknisi/pi-handoff

Transfer context from the current session to a new, focused session. Instead of compacting the conversation (lossy), `/handoff <goal>` sends the serialized conversation plus your stated goal to the current model, which generates a self-contained prompt summarizing relevant decisions, findings, and files. You review/edit the generated prompt in an editor overlay, then the extension creates a new session (linked to the current one via `parentSession`) and pre-fills the editor with the prompt for submission. The generated prompt also appends a session-history chain so the new session can recover full context via `pi --session <path>` if needed.

## What it adds

- Slash command: `/handoff <goal for new thread>`
- UI: a `BorderedLoader` overlay while the prompt generates (abortable), and a full-screen editor overlay (`Edit handoff prompt`) for reviewing/editing the result
- No tools, keybindings, widgets, events, or custom entry types

## Usage

```
/handoff now implement this for teams as well
/handoff execute phase one of the plan
/handoff check other places that need this fix
```

Flow:

1. Collects all messages on the current session branch via `ctx.sessionManager.getBranch()`.
2. Serializes them with `convertToLlm` + `serializeConversation`.
3. Walks the `parentSession` chain (reading the first line of each parent session file with `head -1`) to build a session-history list.
4. Streams a request to the current model with a fixed system prompt ("context transfer assistant") and a user message containing the conversation history and your goal.
5. Appends a `## Session History` section listing session files, most recent first.
6. Opens the result in the editor overlay; on confirm, calls `ctx.newSession({ parentSession })` and sets the edited prompt as the editor draft with `ctx.ui.setEditorText`. You submit it yourself.

Aborting the loader or closing the editor without confirming cancels with a notification; no new session is created.

## Configuration

None. No config files, no options, no environment variables. Uses whatever model and credentials are currently selected in pi.

## Dependencies

- `@earendil-works/pi-coding-agent` (peer, `>=0.86.0`): `ExtensionAPI`, `SessionEntry` types; `BorderedLoader`, `convertToLlm`, `serializeConversation` runtime imports.
- `@earendil-works/pi-ai` (peer): `Message` type; provider streaming via the model registry.

The handoff prompt is generated with `ctx.modelRegistry.complete(ctx.model, { systemPrompt, messages }, { signal })` (pi `>=0.86.0`), which applies `models.json` overrides, extension-registered providers, and request-time auth. A `ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)` pre-check aborts with an error notification when no API key is configured.

## Caveats

- Requires interactive mode (`ctx.hasUI`); does nothing useful headless.
- Depends on pi internals that may change across versions:
  - `ctx.sessionManager.getBranch()`, `getSessionFile()`, `getHeader()` and the `parentSession` header field.
  - Session files being JSONL with the header as the first line (parsed via `head -1 <file>` through `pi.exec`).
  - `ctx.newSession({ parentSession })`, `ctx.ui.custom`, `ctx.ui.editor`, `ctx.ui.setEditorText`.
  - `BorderedLoader`, `convertToLlm`, `serializeConversation` exports from the main package (not a compat path).
- The parent-chain walk shells out with `head -1`; malformed or missing parent files silently terminate the chain.
- Generation uses the currently selected model, so handoff quality/cost tracks whatever model you have active.

## Install

```
pi install /Users/nicknisi/Developer/pi-extensions/packages/handoff
```
