---
'@nicknisi/pi-subagents': patch
---

Fix dispatch progress rendering each task twice while running. pi keeps the renderCall component on screen next to renderResult once the first onUpdate fires, and both rendered the same task tree — renderCall now renders only the header, renderResult owns the tree.
