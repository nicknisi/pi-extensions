# @nicknisi/pi-pin-last-prompt

Sticky header that pins the owning user prompt to the top of the screen while scrolling back through the transcript in fullscreen TUI mode. When you scroll up, a full-width bar appears showing the prompt that "owns" the content at the top of the viewport, updating as you scroll across exchanges (sticky-section-header behavior, a la Claude Code). It disappears when you return to the live tail.

## What it adds

- Widget `pin-last-prompt` — renders nothing itself; exists only as a per-frame hook so the overlay can track scroll state (pi calls widget `render()` every frame, which is where scroll state is observable).
- Overlay — a full-width bar anchored `top-left` at `row: 0, col: 0, width: "100%"`, shown only while scrolled back in fullscreen mode. Rendered with the theme's `selectedBg` background and an accent-colored `\uf007` icon, with the prompt text collapsed to a single line and truncated with `…`.
- Event hooks: `before_agent_start` (records the last prompt), `session_start` (installs the widget), `session_shutdown` (clears widget and state).

No slash commands, tools, keybindings, or custom entry types.

## Requirements

- pi `>= 0.84` (not enforced by `peerDependencies`, which accept any version) — the pinned bar relies on the fullscreen transcript renderer (`TuiAltScreen`) and its `isFollowingOutput` / `getPrimaryScrollView` internals, which only exist in fullscreen mode. In inline mode the extension loads but never shows anything.
- A [Nerd Font](https://www.nerdfonts.com/) in your terminal for the bar's `\uf007` (user) icon. Without one the icon renders as a missing-glyph box; the prompt text is unaffected.

## Usage

No configuration or interaction. Install it, run pi in fullscreen mode (default), scroll up — the bar appears and tracks which prompt's section you're in.

Example of what the bar renders:

```
  <prompt text collapsed to one line, truncated to terminal width>…
```

## Configuration

None. No config files, options, or environment variables.

## Install

```bash
pi install npm:@nicknisi/pi-pin-last-prompt
```

For a local checkout, use `pi install ./packages/pin-last-prompt`.

## Dependencies

Peer deps (provided by the pi runtime):

- `@earendil-works/pi-coding-agent` — `ExtensionAPI`, event hooks, `ctx.ui.setWidget`.
- `@earendil-works/pi-tui` — `TUI` type, `OverlayHandle`, `truncateToWidth`, `visibleWidth` for width-correct padding/truncation.

No npm runtime dependencies, no workspace deps.

## Implementation notes

The prompt offsets are computed by walking pi's transcript component tree: it recurses into `Container` children (pure concatenation of rendered lines) and records the document line offset of each `UserMessageComponent` leaf. The sticky prompt is the last entry whose `start <= scrollTop`, clamped to the first entry when scrolled above it. Offsets are cached and invalidated when the transcript width or `contentHeight` changes (streaming, tool expand/collapse, resize), plus on widget `invalidate()`.

The overlay is `nonCapturing` so it never intercepts input. Overlay stack mutations are deferred to a microtask because `syncTopBar` runs inside the render pass; text updates land in the same frame since the overlay composites after the dock renders.

The bar must not linger at the live tail: any live overlay blocks pi's runtime TUI-mode switching, so it is hidden as soon as `isFollowingOutput` returns to `true`.

## Caveats

- **Leans on pi internals, may break across pi versions.** The sticky lookup depends on internal class names (`UserMessageComponent`, `Container`) and `TUI` internals (`isFollowingOutput`, `getPrimaryScrollView`, scroll view `child`/`contentHeight`/`getContentWidth`). If a pi update renames or restructures these, the extension degrades gracefully: the bar falls back to showing the last prompt sent this session instead of per-section tracking.
- **Fullscreen only.** No effect in inline mode or non-TUI contexts.
- **Single-line prompts.** Prompt text is whitespace-collapsed and truncated to the terminal width; multi-line prompts show only what fits on one line.
- **The blank line above the editor is stock pi** (a hardcoded `Spacer` in the widget container, present even with no extensions). This extension neither adds nor removes it — the widget renders zero lines.
