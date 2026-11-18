---
'@nicknisi/pi-composer': patch
---

`sidepanel` now cuts its border labels into the line as plain text, like the other styles, and the side panel's titles follow `box.inlay` too. The btop-style `┤ ├` brackets render as tall bars in many fonts; set `"box": { "inlay": "bracket" }` to keep them.
