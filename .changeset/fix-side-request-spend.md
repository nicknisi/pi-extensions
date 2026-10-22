---
'@nicknisi/pi-recap': patch
'@nicknisi/pi-llm-council': patch
'@nicknisi/pi-btw': minor
---

recap: summarize the compacted context instead of the raw branch, cap each tool call's arguments at 200 characters, and don't recap again when nothing happened since the last recap; the minimum session length now counts only messages. llm-council: `/council` sends the chairman only the question and the member answers, not the whole conversation. btw: new optional `thinking` config field that overrides the session thinking level for side questions.
