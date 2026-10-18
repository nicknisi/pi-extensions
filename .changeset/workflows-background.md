---
'@nicknisi/pi-workflows': minor
---

Workflow runs now start in the background with a `wf-` id and deliver their result as a message when they finish; there's no 30-minute cap anymore (pass `background: false` to wait inside the tool call). Each run keeps a journal, so `relaunch` (or `/wf relaunch <id>`) replays completed agents and re-runs only failed, changed, or unfinished ones and those after them. Status, stop, pause, and resume accept a workflow id.
