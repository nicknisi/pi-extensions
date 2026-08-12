# @nicknisi/pi-fast

Toggle the premium low-latency inference modes exposed by Anthropic and OpenAI without leaving Pi or maintaining provider-specific request patches. The extension adds `/fast`, injects the supported provider setting into outgoing requests, and shows a compact `fast` footer status only when the current model can actually use it.

Fast mode trades higher usage cost for faster output. It does not change the selected model, its intelligence, or its capabilities.

## What it adds

- **Command:** `/fast` — toggle Fast mode for the current Pi session.
- **Footer status:** `fast` while Fast mode is enabled and the selected model is eligible. Disable it with `showStatus`.
- **Provider request hooks:**
  - Anthropic: merges the `fast-mode-2026-02-01` beta into `anthropic-beta` and adds `speed: "fast"` to Messages API payloads.
  - OpenAI Codex: adds `service_tier: "fast"` to OAuth-backed Codex Responses payloads.
- **Config:** a global default plus an optional trusted project override.

No tools, keybindings, widgets, overlays, or custom message/entry types.

## Install

From npm after the package is published:

```bash
pi install npm:@nicknisi/pi-fast
```

From a local checkout:

```bash
pi install ~/Developer/pi-extensions/packages/fast
```

## Usage

Run the command with no arguments:

```text
/fast
```

Each invocation toggles a session override:

- If Fast mode is currently off, `/fast` turns it on for the session.
- If Fast mode is currently on, `/fast` turns it off for the session.
- The notification reports whether the current model is active or why it is ineligible.
- Starting, resuming, forking, or reloading a session resets the override to the configured default.

Arguments are intentionally not accepted. Use `/fast`, not `/fast on` or `/fast status`.

## Supported providers and models

Support is intentionally explicit so the extension does not send premium-tier fields to models whose APIs reject or ignore them.

| Provider       | Required Pi API          | Supported model IDs                                                  | Injected request setting |
| -------------- | ------------------------ | -------------------------------------------------------------------- | ------------------------ |
| `anthropic`    | `anthropic-messages`     | `claude-opus-5`, `claude-opus-4-8`                                   | `speed: "fast"`          |
| `openai-codex` | `openai-codex-responses` | `gpt-5.4`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra` | `service_tier: "fast"`   |

OpenAI Codex eligibility also requires ChatGPT OAuth (`/login` in Pi). API-key-backed `openai` models use a different provider and are not modified by this extension.

Anthropic Fast mode is a research preview that must be enabled for the account. It is available through the first-party Claude API, not Amazon Bedrock, Google Cloud, or Microsoft Foundry. The extension can add the request fields, but it cannot grant preview access.

Claude Opus 4.6 and 4.7 are deliberately excluded. Anthropic no longer offers Fast mode on those models: 4.6 silently runs at standard speed, while 4.7 rejects `speed: "fast"`.

## Configuration

Copy the example for a global default:

```bash
mkdir -p ~/.pi/agent/configs
cp fast.example.json ~/.pi/agent/configs/fast.json
```

Default config:

```json
{
  "enabled": false,
  "showStatus": true
}
```

| Field        | Type      | Default | Description                                                                               |
| ------------ | --------- | ------- | ----------------------------------------------------------------------------------------- |
| `enabled`    | `boolean` | `false` | Fast-mode state at session start, before a `/fast` session override.                      |
| `showStatus` | `boolean` | `true`  | Show `fast` in Pi's footer while Fast mode is enabled and the selected model is eligible. |

Config precedence, from lowest to highest:

1. Built-in defaults.
2. Global config: `<agentDir>/configs/fast.json` (normally `~/.pi/agent/configs/fast.json`; honors `PI_CODING_AGENT_DIR`).
3. Trusted project config: the nearest `.pi/configs/fast.json` found while walking from `ctx.cwd` toward the filesystem root.
4. The in-memory `/fast` override for the current session.

Project config is ignored unless `ctx.isProjectTrusted()` is true. Config is reloaded on `session_start`; run `/reload` or start another session after editing it. Malformed JSON or non-boolean known fields produce a warning and fall back to the lower-precedence value. Unknown fields are ignored.

A project override can contain only the value it needs to change:

```json
{
  "enabled": true
}
```

## Request behavior

The extension is conservative about request mutation:

1. It checks the active provider, API, model ID, and—on Codex—OAuth auth.
2. It verifies that the provider payload's `model` exactly matches Pi's selected model.
3. It returns a complete cloned payload with one added field; Pi's `before_provider_request` hook treats returned values as full replacements.
4. If a payload already contains `speed` or `service_tier`, that explicit value wins and the extension leaves the payload unchanged.

For Anthropic, beta headers are merged case-insensitively and deduplicated. The extension preserves beta values already present in request/model headers and reconstructs Pi's OAuth, interleaved-thinking, and fine-grained-tool-streaming betas when the selected model needs them. This avoids the common failure where assigning `anthropic-beta` for Fast mode accidentally removes a beta required by Pi's provider implementation.

## Cost and performance caveats

- **Higher cost or credit use.** Fast mode is a premium service tier. Review the linked provider pricing before enabling it by default.
- **Anthropic prompt caches are speed-specific.** Switching between standard and Fast mode causes a prompt-cache miss because the two speeds do not share cached prefixes.
- **Anthropic capacity is separate.** Fast mode has dedicated rate limits and may return `429` or `529`; this extension does not retry at standard speed automatically.
- **Codex credit multipliers vary by model.** OpenAI currently documents 2.5× ChatGPT credit use for GPT-5.5/5.6 and 2× for GPT-5.4. API Priority/Fast processing has separate token pricing.
- **Faster output is not lower time-to-first-token.** Anthropic describes the gain as output tokens per second; OpenAI's Codex documentation describes a supported-model speed increase.
- **Model support changes.** The allowlists match the provider documentation and Pi catalog at release time. A newly released model remains ineligible until this package is updated deliberately.

Provider documentation:

- [Anthropic Fast mode (research preview)](https://platform.claude.com/docs/en/build-with-claude/fast-mode)
- [OpenAI API Fast mode](https://developers.openai.com/api/docs/guides/fast-mode)
- [Codex speed and credit usage](https://developers.openai.com/codex/speed)

## Dependencies

- `@earendil-works/pi-coding-agent` (peer, `*`) — extension hooks, model/auth context, config directory helpers, slash commands, notifications, and footer status.
- Node built-ins: `node:fs` and `node:path` for config loading.

No npm runtime dependencies or workspace dependencies.

## Caveats

- Provider payload fields and beta headers are provider-specific wire contracts. Pi exposes the interception hooks, but a provider can change its accepted values independently of Pi.
- The extension relies on `before_provider_headers` mutating headers in place and `before_provider_request` replacing the entire payload when it returns a value.
- `/fast` is session-local and is not persisted. Set `enabled` in config for a persistent default.
- The footer confirms that the extension considers Fast mode active; it does not inspect the provider response's reported tier/speed. Provider-side downgrade, missing preview entitlement, capacity errors, and billing remain authoritative.

## Development

From the repository root:

```bash
pnpm vitest run packages/fast
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

Smoke-test extension loading with a scratch agent directory:

```bash
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
PI_CODING_AGENT_DIR="$tmp" pi --no-extensions -e packages/fast/index.ts --list-models
```
