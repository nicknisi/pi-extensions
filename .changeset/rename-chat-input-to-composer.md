---
'@nicknisi/pi-composer': minor
---

Rename package: `@nicknisi/pi-chat-input` is now `@nicknisi/pi-composer`. Pure rename — no behavior changes. Breaking for existing installs: the config file moves from `configs/chat-input.json` to `configs/composer.json` (rename your file), the command is now `/composer`, and installs should point at `packages/composer`. The old npm package will be deprecated in favor of this one; version history carries over.
