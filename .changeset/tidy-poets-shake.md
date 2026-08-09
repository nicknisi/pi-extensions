---
'@nicknisi/pi-statusline': patch
---

Render extension statuses (`ctx.ui.setStatus()`) in the footer and cap the context bar at 20 columns. Replacing pi's footer meant every extension's status indicator was silently dropped; each status now renders as its own segment with whitespace folded and SGR colors left intact.
