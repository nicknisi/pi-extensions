---
'@nicknisi/pi-llm-council': patch
---

Fix the `llm_council` tool rendering the member/chairman progress tree twice while running. The tool header now shows only the spinner, and the live tree is drawn once by the result renderer. This also removes module-level progress state that concurrent council calls could share.
