# @nicknisi/pi-fast

## 0.3.2

### Patch Changes

- Updated dependencies [245ee0f]
  - @nicknisi/pi-shared@0.8.1

## 0.3.1

### Patch Changes

- Updated dependencies [7801bfc]
  - @nicknisi/pi-shared@0.8.0

## 0.3.0

### Minor Changes

- bafed19: Support Fast mode on Claude Opus 5.5 (generally available, no beta header) and the GPT-6 Codex models. Send the preview beta through the payload's `betas` so pi's own betas are kept (the old header override dropped the mid-conversation effort betas on Opus 5), and fall back to standard speed for 60 seconds after a Fast-mode 429/529.
- c22cede: Fast mode now reaches subagent and workflow children: they follow the session's `/fast` toggle and share its rate-limit cooldown. The shared runtime gains `childExtensions()`, a registry of inline extensions loaded into every child.

### Patch Changes

- Updated dependencies [c22cede]
- Updated dependencies [01de359]
- Updated dependencies [79ab2c6]
- Updated dependencies [db67986]
  - @nicknisi/pi-shared@0.7.0

## 0.2.0

### Minor Changes

- 24a9f8e: Add a Fast mode extension for supported Anthropic Claude and OpenAI Codex models, with trusted global/project config, safe provider request injection, a session toggle, and active-model footer status.
