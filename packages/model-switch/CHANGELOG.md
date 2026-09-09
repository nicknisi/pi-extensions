# @nicknisi/pi-model-switch

## 0.3.0

### Minor Changes

- 43a07d6: Add `/model-switch add` and `/model-switch add-current` to save models to a chosen section without editing JSON. Preserve existing config data and skip duplicates within each section.

## 0.2.1

### Patch Changes

- ddbad8d: Fix picker filtering: typing a model name (e.g. "claude" or "kimi") now matches anywhere in the provider/modelId string and searches across all sections, instead of prefix-matching only within the active section

## 0.2.0

### Minor Changes

- 547da44: Add machine-local preferred model switching and a fuzzy section-aware picker with configurable shortcuts.
