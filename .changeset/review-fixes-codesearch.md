---
'@nicknisi/pi-codesearch': patch
---

`codefetch` now caps `gh` output at the body limit, reports oversized files instead of silently falling back, and includes gh's error when the public fallback also fails. Empty files no longer error for explicit line ranges, blank-line slices are no longer mislabeled as empty files, and truncation notices point to the next line to fetch.
