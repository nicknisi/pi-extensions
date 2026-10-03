---
'@nicknisi/pi-subagents': minor
---

Add a per-task `cwd` (dispatch schema and profile frontmatter) and host-configured `childExtensionPaths` (factory option or `<agentDir>/subagents.json`).

`cwd` is relative to the session cwd and jailed inside it, so a host whose session cwd is a workspace root holding several repository checkouts can point a worktree task at one checkout instead of failing with "not inside a git repository". `childExtensionPaths` names extension files every child loads, so a host whose model routing lives in an extension (a provider registered with `pi.registerProvider`) gets working children instead of ones with no usable model. Both are host configuration or explicit task fields; children stay hermetic otherwise.
