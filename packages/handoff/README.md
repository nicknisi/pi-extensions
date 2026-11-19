# @nicknisi/pi-handoff

Transfer context from the current session to a new, focused session. Instead of compacting the conversation (lossy), `/handoff <goal>` sends the serialized conversation plus your stated goal to the current model, which generates a self-contained prompt summarizing relevant decisions, findings, and files. You review/edit the generated prompt in an editor overlay, then the extension creates a new session (linked to the current one via `parentSession`) and pre-fills the editor with the prompt for submission. The generated prompt also appends the chain of previous session files (JSONL), so the new session can search them with `rg`/`grep` when it needs exact details.

## What it adds

- Slash command: `/handoff <goal for new thread>`
- UI: in the TUI, a `BorderedLoader` overlay while the prompt generates (abortable); in RPC mode, an info notification instead. Then a full-screen editor overlay (`Edit handoff prompt`) for reviewing/editing the result
- No tools, keybindings, widgets, events, or custom entry types

## Usage

```
/handoff now implement this for teams as well
/handoff execute phase one of the plan
/handoff check other places that need this fix
```

Flow:

1. Collects what the agent saw on the current session branch via `ctx.sessionManager.getBranch()`: messages plus compaction summaries, `/tree` branch summaries, and extension custom messages.
2. Serializes them with `convertToLlm` + `serializeConversation`, newest first, keeping at most ~70% of the model's context window (chars ÷ 4 as the token estimate). Older messages past that budget are dropped with an `[N earlier messages omitted …]` marker, so very long or already-compacted sessions don't overflow the request. If the newest message alone exceeds the budget, it is truncated rather than dropped.
3. Walks the `parentSession` chain (reading the JSONL header line of each parent session file with `node:fs`) to build a session-history list. The walk stops at a missing or malformed file, a cycle, or 20 sessions.
4. Sends a single non-streaming request (`ctx.modelRegistry.complete`) to the current model with a fixed system prompt ("context transfer assistant") and a user message containing the conversation history and your goal.
5. Appends, without another model call:
   - `## My Recent Requests (verbatim)`: your last 5 messages, quoted exactly (each capped at 2,000 chars), so constraints the summary paraphrased away survive.
   - A note that the handoff may be out of date and the new session should check git status and the relevant files before acting.
   - `## Session History`: the session JSONL files, most recent first, with a hint to search them with `rg`/`grep` for exact details.
6. Opens the result in the editor overlay; on confirm, calls `ctx.newSession({ parentSession, withSession })` and sets the edited prompt as the new session's editor draft from the `withSession` callback (the old `ctx` is stale after the switch). You submit it yourself.

Aborting the loader (TUI only) or closing the editor without confirming cancels with a notification; no new session is created.

## Configuration

None. No config files, no options, no environment variables. Uses whatever model and credentials are currently selected in pi.

## Dependencies

- `@earendil-works/pi-coding-agent` (peer, `>=0.86.0`): `ExtensionAPI`, `SessionEntry` types; `BorderedLoader`, `convertToLlm`, `serializeConversation` runtime imports.
- `@earendil-works/pi-ai` (peer): `Message` type; provider calls via the model registry.

The handoff prompt is generated with `ctx.modelRegistry.complete(ctx.model, { systemPrompt, messages }, { signal })` (pi `>=0.86.0`), which applies `models.json` overrides, extension-registered providers, and request-time auth. A `ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)` pre-check aborts with an error notification when no API key is configured.

## Caveats

- Requires a dialog-capable UI (`ctx.hasUI`): works in the TUI and in RPC mode (where generation runs without the loader and can't be aborted). Print and JSON modes just report an error.
- Depends on pi internals that may change across versions:
  - `ctx.sessionManager.getBranch()`, `getSessionFile()`, `getHeader()` and the `parentSession` header field.
  - Session files being JSONL with the header as the first line.
  - `ctx.mode`, `ctx.newSession({ parentSession })`, `ctx.ui.custom`, `ctx.ui.editor`, `ctx.ui.setEditorText`.
  - `BorderedLoader`, `convertToLlm`, `serializeConversation` exports from the main package (not a compat path).
- Malformed or missing parent files silently terminate the parent-chain walk.
- Generation uses the currently selected model, so handoff quality/cost tracks whatever model you have active.

## Install

```
pi install /Users/nicknisi/Developer/pi-extensions/packages/handoff
```
