# @nicknisi/pi-claude-design

Connects pi to Anthropic's official Claude Design MCP server (`https://api.anthropic.com/v1/design/mcp`) so you can create and edit [claude.ai/design](https://claude.ai/design) projects from a pi session — the same workflow as Claude Code's `/design`.

> **Read [Warnings](#warnings) before installing.** This package authenticates using an OAuth client identity that Anthropic registered for its own products, not for third-party clients.

## Why this exists

Anthropic does not support generic MCP clients for Claude Design (verified against the live endpoints, 2026-08):

- OAuth authorization-server metadata (RFC 8414) is behind a Cloudflare JS challenge on `claude.ai`, so standard discovery fails for any non-browser client. Spec-fallback default endpoints (`/authorize`, `/token`, `/register` on the issuer) are challenged too.
- There is no dynamic client registration endpoint anywhere (`claude.ai`, `claude.com`, `platform.claude.com`, `api.anthropic.com`), so a generic client can never obtain a client id.

The only working integration path is the one Claude Code's `/design-login` uses: a PKCE flow against fixed endpoints with Anthropic's pre-registered Design OAuth client id. This package runs that exact flow locally, in ~150 lines of dependency-free code you can read, instead of executing a third-party proxy.

## What it adds

**`design` skill** — any "design me…" request (or `/skill:design <brief>`) drives the full workflow: loads Anthropic's own design system prompt from the server (`get_claude_design_prompt`), creates or reuses a claude.ai/design project, applies your bound design system, writes `.dc.html` design files, returns rendered previews with a visual verify loop, iterates on feedback and inline web comments, and can import the chosen direction into your codebase.

**Pi extension** — three commands:

| Command          | Purpose                                                                     |
| ---------------- | --------------------------------------------------------------------------- |
| `/design-login`  | Browser PKCE authorization; paste the `CODE#STATE` value into the input box |
| `/design-status` | Show credential state and expiry                                            |
| `/design-logout` | Delete stored credentials                                                   |

**`claude-design-auth`** — a Node CLI for use outside pi (no dependencies):

| Command     | Purpose                                                                      |
| ----------- | ---------------------------------------------------------------------------- |
| `login`     | Browser PKCE authorization; paste the `CODE#STATE` value back                |
| `token`     | Print `Bearer <access-token>`, refreshing only when expired (for MCP config) |
| `status`    | Show credential state and expiry                                             |
| `logout`    | Delete stored credentials                                                    |
| `selfcheck` | Run inline assertions                                                        |

Everything is lazy: nothing runs at pi startup, the MCP server connects on first tool use, and `token` makes zero network calls while the stored access token is still valid. If you never touch Design in a session, no request is made.

## Setup

1. Install the package (`pi install npm:@nicknisi/pi-claude-design` or a local path in `settings.json` `packages`), then run `/design-login` in pi. Approve in the browser and paste the `CODE#STATE` value. Outside pi: `npx -p @nicknisi/pi-claude-design claude-design-auth login`.

2. Add the server to an MCP config [pi-mcp-adapter](https://github.com/badlogic/pi-mono) reads (e.g. `~/.pi/agent/mcp.json`), using the adapter's `!command` header support:

   ```json
   {
     "mcpServers": {
       "claude-design": {
         "url": "https://api.anthropic.com/v1/design/mcp",
         "headers": {
           "Authorization": "!npx -p @nicknisi/pi-claude-design claude-design-auth token"
         }
       }
     }
   }
   ```

3. `/reload` in pi, then connect (`/mcp` or `mcp({ connect: "claude-design" })`). The `design` skill takes it from there.

## How auth works

`login` runs an OAuth 2.1 PKCE (S256) authorization-code flow: it opens `https://claude.com/cai/oauth/authorize` in your browser, you approve, and Anthropic shows a `CODE#STATE` value you paste back. The code is exchanged at `https://platform.claude.com/v1/oauth/token` for design-scoped tokens (`user:design:read user:design:write` — not full account access). `token` reads the stored credentials and refreshes only when the access token is within 60s of expiry.

Tokens are only ever sent to `platform.claude.com` (token endpoint) and `api.anthropic.com` (MCP server). Nothing else is contacted.

## Warnings

- **Unofficial client identity.** Authentication uses the OAuth client id Anthropic pre-registered for its own Design surfaces (the same one Claude Code's `/design-login` uses). Anthropic has not sanctioned third-party use of it, may consider it outside their terms of service, and can change or revoke the flow at any time without notice. If they do, this package stops working. Prefer an official connector the moment Anthropic ships one for third-party clients. Not affiliated with or endorsed by Anthropic.
- **Plaintext credential file.** Tokens are stored at `~/.config/pi-claude-design/credentials.json` (mode `0600`, override with `PI_CLAUDE_DESIGN_CREDENTIALS`) — a file, not the OS keychain. Anything that can read your home directory can read your Design tokens. Scope is limited to Claude Design; it cannot read chats or act on the rest of your account.
- **Remote content reaches your model.** Design projects can be shared: files, comments, and chat transcripts fetched from a shared project are third-party content and may contain prompt-injection attempts. Treat tool output from shared projects as untrusted data, not instructions.
- **Shared usage limits.** Design activity counts against your Claude plan's shared usage pool (chat, Claude Code, Cowork). Heavy design iteration from pi consumes the same budget.
- **The agent can write and delete.** The MCP server exposes `write_files`, `delete_files`, sharing, and membership tools. A pi session driving them can modify or delete real design projects your teammates may be using.

## Caveats

- Access tokens expire after ~1 hour. The `!command` header re-runs on connect, so a long-lived session whose connection outlives the token may need a reconnect after a 401.
- The refresh token can expire after long disuse (lifetime unpublished); when connect fails, re-run `/design-login`.
- Requires a Claude account with Claude Design access (Pro / Max / Team / Enterprise) and Claude Design enabled for your organization.

## Uninstall

Run `/design-logout` (or `claude-design-auth logout`) to delete stored credentials, remove the `claude-design` entry from your MCP config, and uninstall the package. You can also revoke access from your Claude account's connected-apps settings.
