---
'@nicknisi/pi-checkpoint': minor
---

Add Checkpoint (renamed from self-compact before release): a note-bearing `self_compact` tool that checkpoints a long-running agent, replaces the summary instruction, and resumes the exact next action after compaction without another human prompt. Includes configurable soft/warning/hard thresholds (`--compact-soft-at`, `--compact-at`, `--compact-buffer`), an editable `--compact-prompt` override, a 20-cell context widget, and `/self-compact-info` / `/self-compact-now` commands.
