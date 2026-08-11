---
'@nicknisi/pi-model-switch': patch
---

Fix picker filtering: typing a model name (e.g. "claude" or "kimi") now matches anywhere in the provider/modelId string and searches across all sections, instead of prefix-matching only within the active section
