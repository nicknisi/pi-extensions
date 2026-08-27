# @nicknisi/pi-adr

Injects the repo's ADR index (`docs/decisions/`) into the system prompt as a steering veto list, so the agent knows which directions are already settled before it proposes anything.

## What it adds

- `before_agent_start` hook — walks up from cwd to the nearest ancestor with `docs/decisions/` and appends a framing sentence plus the sorted filename list to the system prompt. Filenames only (~10 tokens per ADR); full files are read on demand by the agent. Recomputed per prompt, so it's never stale. No-ops when no `docs/decisions/` exists.

No slash commands, tools, keybindings, widgets, or config.

Pairs with a user-level prompt template (`~/.pi/agent/prompts/adr.md`, not part of this package) that writes the next numbered ADR from the current conversation on `/adr`.

## Conventions

- ADRs are `NNNN-kebab-title.md` directly in `docs/decisions/`. The filename is the veto — make titles descriptive ("no package service primitive", not "refactor approach").
- Superseded ADRs move to `docs/decisions/superseded/`, which drops them out of the injected list (the readdir is non-recursive; no status parsing).
- Template files (`0000-*`) are excluded.

## Install

```bash
pi install npm:@nicknisi/pi-adr
```

## Dependencies

Peer dep on `@earendil-works/pi-coding-agent` (provided by the pi runtime). No runtime dependencies.
