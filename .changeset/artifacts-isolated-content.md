---
'@nicknisi/pi-artifacts': minor
---

Artifacts now open in a review page that frames the artifact on its own origin. An artifact's scripts (including raw HTML in Markdown and CDN scripts) can no longer call the review API, so they can't send reviews, make gists, or touch your clipboard on your behalf. Comments, pins, decisions, screenshots, and shares work as before; a live reload now leaves your drafts and composer untouched, and links to other sites open in a new tab.
