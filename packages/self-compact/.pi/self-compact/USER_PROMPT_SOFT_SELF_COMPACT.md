Optional heads-up: this session is using {{tokens}} tokens ({{percent}}% of the
{{context_window}}-token window). This guidance is optional — you do not have to
act on it yet, and ordinary tools remain fully available.

If you are approaching a natural stopping point, consider calling `self_compact`
soon. The warning threshold is {{warning_tokens}} tokens and tool use is paused
once context reaches the hard cutoff at {{hard_tokens}} tokens ({{hard_percent}}%).

When you do checkpoint, write a `note_to_self` that captures:

- the work already completed and its exact file paths,
- verification results (commands run and their outcomes),
- the single next unfinished action to resume, and
- whether the overall task is already complete.

The note is delivered back to you verbatim after compaction, so it is the only
thing that survives to describe where to pick up.
