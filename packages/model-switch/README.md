# @nicknisi/pi-model-switch

Cycle or fuzzy-pick from a machine-local, sectioned list of preferred Pi models.

This package is useful when the same Pi configuration is shared across machines but each machine has different providers, credentials, or model preferences. The extension reads an untracked local config instead of using `enabledModels`, skips unavailable entries, and leaves Pi's normal `/model` and Ctrl+L picker unchanged.

## Install

From npm after the package is published:

```bash
pi install npm:@nicknisi/pi-model-switch
```

From a local checkout:

```bash
pi install ~/Developer/pi-extensions/packages/model-switch
```

## Configure shortcuts

The defaults are Ctrl+Shift+M forward, Ctrl+Shift+Alt+M backward, and Ctrl+Shift+L for the fuzzy picker. Override any of them in Pi's existing `~/.pi/agent/keybindings.json`:

```json
{
  "model-switch.cycleForward": "ctrl+shift+m",
  "model-switch.cycleBackward": "ctrl+shift+alt+m",
  "model-switch.select": "ctrl+shift+l"
}
```

These extension-owned action IDs are ignored by Pi's built-in keybinding manager and read by model-switch during extension load. Run `/reload` or restart Pi after changing them. Each value must be one non-empty Pi key string; a missing or invalid value falls back to its default.

## Configure models

Copy the example config:

```bash
mkdir -p ~/.pi/agent/configs
cp model-switch.example.json ~/.pi/agent/configs/model-switch.json
```

Or create `~/.pi/agent/configs/model-switch.json` directly with named sections:

```json
{
  "sections": {
    "work": ["cloudflare-ai-gateway/gpt-5.6-sol", "cloudflare-ai-gateway/claude-opus-5"],
    "personal": ["fireworks/accounts/fireworks/models/kimi-k3"]
  }
}
```

Section names are arbitrary — define as many as you want. The legacy flat format also works:

```json
{
  "models": ["cloudflare-ai-gateway/gpt-5.6-sol"]
}
```

The file is read on every interaction, so edits take effect without reloading Pi.

### Config schema

| Field      | Type                       | Default | Description                                                                        |
| ---------- | -------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `sections` | `Record<string, string[]>` | —       | Named sections of ordered `provider/model-id` references. Preferred over `models`. |
| `models`   | `string[]`                 | —       | Legacy flat list. Treated as a single unnamed section when `sections` is absent.   |

The first `/` separates the provider from the model ID. Additional slashes belong to the model ID, so references such as `fireworks/accounts/fireworks/models/kimi-k3` work as expected.

Keep this config machine-local and untracked. A personal machine and work machine can each provide their own sections while sharing the installed extension and the rest of your Pi dotfiles.

## Behavior

### Cycling

- **Ctrl+Shift+M** moves forward through usable models in the active section.
- **Ctrl+Shift+Alt+M** moves backward.
- The active section is the one containing the current model. If the current model is not in any section, the first section is used.
- Cycling wraps at both ends within the active section.

### Fuzzy picker

- **Ctrl+Shift+L** or `/model-switch` opens a fuzzy-searchable TUI picker.
- **Tab** cycles between sections within the picker.
- Type to fuzzy-filter models within the active section.
- The picker preserves config order, marks the current model with `●`, switches the chosen entry, and treats cancellation as a no-op.
- Sections with no usable models are hidden from the picker.

### General

- Missing models and models without working provider authentication are skipped while preserving config order.
- If no configured model is usable, Pi keeps the current model and shows a warning.
- Invalid JSON or invalid config values produce a warning containing the config path.
- The extension never changes the model at startup.

`enabledModels` is not read or modified. Pi's `/model` command and Ctrl+L picker continue to expose the normal available catalog.

## Troubleshooting

### The custom shortcuts do not respond

Check the `model-switch.cycleForward`, `model-switch.cycleBackward`, and `model-switch.select` values in `~/.pi/agent/keybindings.json`, then run `/reload`. Check Pi's startup diagnostics for another extension using the same physical keys, and verify that your terminal reports the configured combinations as distinct modified key events. No built-in Pi keybinding changes are required.

### A configured model is skipped

Check that Pi knows the exact reference and that its provider is authenticated:

```bash
pi --list-models
```

Model entries must use the full `provider/model-id` shown by Pi. Authentication is machine-specific and can be managed with `/login` and `/logout`.

### No configured models are available

The config may be missing, empty, malformed, or contain only missing/unauthenticated entries. Pi's warning includes the active config path. `PI_CODING_AGENT_DIR` changes that path along with the rest of the agent configuration.

## Caveats

- This extension owns only its custom cycle and fuzzy picker; it cannot and does not mutate Pi's read-only scoped model list.
- The picker uses a custom search + list component with `ctx.ui.custom()`; native `/model` and Ctrl+L remain available for the full catalog.
- Terminal support for multi-modifier keys varies; configure simpler non-conflicting keys or use a terminal with the Kitty keyboard protocol when modified keys are not distinguishable.
- Availability is checked on each interaction, which may resolve provider credentials before switching.
- Duplicate references within a section are preserved as written; avoid them unless repeated cycle positions are intentional.

## Development

From the repository root:

```bash
pnpm vitest run packages/model-switch
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

Smoke-test extension loading with a scratch agent directory:

```bash
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
PI_CODING_AGENT_DIR="$tmp" pi --no-extensions -e packages/model-switch/index.ts --list-models
```
