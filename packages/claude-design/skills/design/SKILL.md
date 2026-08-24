---
name: design
description: Create and iterate on UI designs, prototypes, decks, and mockups in Claude Design (claude.ai/design) via its official MCP server. Use when the user asks to design something, wants UI mockups or artboard options, says /design, or wants to import a Claude Design project into the codebase.
---

# Claude Design

Drive Anthropic's Claude Design through the `claude-design` MCP server. Designs live in real claude.ai/design projects: rendered previews, shareable links, editable in the web UI.

## Prerequisites

The `claude-design` MCP tools (`claude-design_*`) must be available. If the server is not connected, connect it (`mcp({ connect: "claude-design" })`). If connecting fails with an auth error, tell the user to run `/design-login` and stop.

## Workflow

1. **Load Anthropic's design guidance first.** Call `claude-design_get_claude_design_prompt` and follow it — it is the same system prompt the claude.ai/design agent uses (file conventions, artboard structure, quality bar). Consult `claude-design_read_design_skill` for specific design-quality topics when relevant. Do not improvise your own conventions when theirs conflict.
2. **Pick a project.** `claude-design_list_projects` to reuse an existing project when the user is iterating; otherwise `claude-design_create_project`. Check `claude-design_list_design_systems` and apply the user's design system when one exists.
3. **Gather local context.** When designing for the current codebase, scan it for design tokens (tailwind config, CSS variables), existing components, and brand assets, and reflect them in the design files.
4. **Write the design.** `claude-design_finalize_plan` with the exact paths, then `claude-design_write_files`. For multiple directions, produce distinct labeled variations (A/B/C) as separate artboards/files, per the loaded design prompt's conventions.
5. **Show it.** `claude-design_render_preview` and give the user the `serve_url` (and project URL) to open. Do not describe the design in prose as a substitute for the preview.
6. **Iterate.** Apply feedback with further `finalize_plan` → `write_files` rounds against the same project. Check `claude-design_list_comments` for inline comments left in the web UI and `claude-design_ack_comments` after addressing them.
7. **Implement (optional).** When the user picks a direction and wants it built, `claude-design_read_file` the chosen files and implement them in the codebase using its real components and conventions.

## Notes

- Auth is lazy; the first tool call may take a moment while the server connects and refreshes the token. A 401 after a long idle session means reconnect; a persistent auth failure means `/design-login`.
- Sharing: `claude-design_update_sharing` / `claude-design_add_member` when the user asks to share.
