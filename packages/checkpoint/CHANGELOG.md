# @nicknisi/pi-checkpoint

## 0.2.0

### Minor Changes

- d6c0542: Require Pi 0.87.0 for safe turn-boundary guidance and deferred continuation scheduling. Acknowledge handoffs only after the continuation is journaled, recover unanswered notes without recompacting, and reject early checkpoints before locking tools. Refresh model-facing usage guidance per request, steer busy manual checkpoint requests at the next tool boundary, and strengthen summary instructions to preserve verified progress and unfinished work.
- d6c0542: Add Checkpoint (renamed from self-compact before release): a note-bearing `self_compact` tool that checkpoints a long-running agent, replaces the summary instruction, and resumes the exact next action after compaction without another human prompt. Includes configurable soft/warning/hard thresholds (`--compact-soft-at`, `--compact-at`, `--compact-buffer`), an editable `--compact-prompt` override, a 20-cell context widget, and `/self-compact-info` / `/self-compact-now` commands.

### Patch Changes

- d6c0542: Color the existing statusline context bar using self-compaction thresholds. Hide the duplicate Checkpoint widget when the statusline is active, while preserving standalone fallbacks and the footer's existing remaining-context display.
