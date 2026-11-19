---
'@nicknisi/pi-cloak': patch
---

Cloak now masks real grep output (per-line file paths, patterns anchored after the `path:N: ` prefix), matches directory globs against absolute and `./` read paths, covers the `powershell` tool, and masks later reads of truncated shell output saved to a temp file. The README install instructions and caveats (including that `!cmd` output is not cloaked) are corrected.
