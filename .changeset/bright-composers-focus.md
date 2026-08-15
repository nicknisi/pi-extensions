---
'@nicknisi/pi-composer': patch
---

Restore focused-border updates in fullscreen Pi sessions, whose viewport listener consumes terminal focus events before extension input listeners run. Also initialize tmux focus from attached clients so background sessions start dim.
