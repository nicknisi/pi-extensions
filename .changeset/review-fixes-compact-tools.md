---
'@nicknisi/pi-compact-tools': patch
---

Collapsed previews now skip pi's `... (N earlier lines)` truncation hint so long bash output shows real output, collapsed rows respect `outputPad` like expanded rows, and collapsed lines are cached per width with large results scanned only up to 64 KB.
