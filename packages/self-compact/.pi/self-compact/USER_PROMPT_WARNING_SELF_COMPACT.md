It is time to compact soon. This session is using {{tokens}} tokens
({{percent}}% of the {{context_window}}-token window), past the warning
threshold of {{warning_tokens}} tokens. Tool use will be paused once context
reaches the hard cutoff at {{hard_tokens}} tokens ({{hard_percent}}%).

Finish or safely pause your current action, then call `self_compact` before you
hit the hard cutoff. Do not start new large work first.

Write a `note_to_self` that captures:

- the work already completed and its exact file paths,
- verification results (commands run and their outcomes),
- the single next unfinished action to resume, and
- whether the overall task is already complete.

The note is delivered back to you verbatim after compaction, so it is the only
thing that survives to describe where to pick up. Keep it precise.
