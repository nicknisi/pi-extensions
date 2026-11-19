---
'@nicknisi/pi-checkpoint': patch
---

Unpassed threshold flags now fall back to 60%/70%/10% of the window when the 225k/250k/20k defaults don't fit the model (e.g. 200k models), instead of blocking every tool. Pending or failed handoffs now still compact after /fork or /clone, `/self-compact-now` no longer re-sends a continuation that is already queued or delivered, malformed saved handoff state is ignored instead of crashing, and the retention check no longer re-reads settings files on every request.
