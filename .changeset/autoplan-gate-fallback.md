---
'@nicknisi/pi-workflows': patch
---

`autoplan.js`: an off-list answer at the decision gate no longer silently resolves to the advisor's recommendation. The run returns `decided: false` with the custom text so it can be re-mined, matching the "the human is the gate" design.
