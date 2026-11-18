---
'@nicknisi/pi-composer': major
---

Composer now renders the whole bottom of pi's screen: the input box, the footer, the row above the box, and pi's working message and spinner. Pick a style (`classic`, `toad`, `keycaps`, `starship`, `sidepanel`) and override any part of it with slots and items in `composer.json`. `/composer style <name>` tries a style for the session and `/composer preview` steps through every state.

Breaking: `composer.json` has a new nested schema. Pre-1.0 keys (`boxedView`, `corners`, `glowStyle`, `sessionNameFormat`, …) are reported once and ignored; see "Migrating from 0.x" in the README. The statusline footer and the spinner verbs are now built in, so remove `@nicknisi/pi-statusline` and `@nicknisi/pi-spinner`.

Also fixes: lines changed now count pi's edit diffs (they never appeared before), the context meter survives narrow panes, and pi's retry and compaction notices show wherever the working message is placed.
