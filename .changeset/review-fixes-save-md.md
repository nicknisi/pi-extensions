---
'@nicknisi/pi-save-md': patch
---

`/save-md` now reports write failures (such as a missing parent directory) as a notification instead of throwing, and falls back to the most recent assistant message that has text when the latest turn has none. The package description and README now match actual behavior.
