# @nicknisi/pi-handoff

Transfer context from the current session to a new, focused session. Instead of compacting the conversation (lossy), `/handoff <goal>` sends the serialized conversation plus your stated goal to the current model, which generates a self-contained prompt summarizing relevant decisions, findings, and files. You review/edit the generated prompt in an editor overlay, then the extension creates a new session (linked to the current one via `parentSession`) and pre-fills the editor with the prompt for submission. The generated prompt also appends the chain of previous session files (JSONL), so the new session can search them with `rg`/`grep` when it needs exact details.

## What it adds

- Slash command: `/handoff <goal for new thread>`
- UI: in the TUI, a `BorderedLoader` overlay while the prompt generates (abortable); in RPC mode, an info notification instead. Then a full-screen editor overlay (`Edit handoff prompt`) for reviewing/editing the result
- After every compaction (automatic or `/compact`): one hidden `handoff:carried-inputs` message with your own words from the summarized part of the session, verbatim (see **Your words survive compaction** below)
- No tools, keybindings or widgets

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

## Your words survive compaction

A compaction replaces the older conversation with a summary written by the model. In an audit of 17 real compactions from long sessions with 1M-token windows, the summaries kept 81% of the user's instructions exactly, softened 15% (a lost qualifier, "best" became "simplest") and dropped 4%. The dropped ones were approvals given through `ask_user_question` and rules inside a skill pasted as the first message, and in 7 of 17 the summary's goal and next steps contradicted its own latest turn. Some summaries also listed rules the user never gave.

So after each compaction this extension posts one hidden message (`customType: "handoff:carried-inputs"`, `display: false`) holding, verbatim:

- your **first message** of the session (up to 6,000 characters, so a pasted skill fits), and
- your **newest messages and `ask_user_question` answers** from the summarized span, filled newest-first (each up to 2,000 characters) until about 16,000 characters in total, then shown in their original order with their entry IDs. If some were left out, it says how many and names the session file to search.

It opens with a short note for the model: the summary can drop, soften or invent rules, so your words win where they disagree, a later message overrides an earlier one, and these are history rather than new requests (check the live state before acting on one).

Pi's summary itself is unchanged, and nothing replaces Pi's compaction, so this works alongside any other extension that watches compaction. The message is posted from `session_compact`: during a run Pi delivers it before the next model call, and after an idle `/compact` it's stored without starting a turn.

Caveats: it carries text only (images are skipped) and only answers from `ask_user_question`. If an earlier carried message is still inside the recent span Pi keeps, the context can briefly hold two copies; with large windows and the usual `keepRecentTokens` that rarely happens.

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
