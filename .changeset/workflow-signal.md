---
'@nicknisi/pi-shared': minor
---

`runWorkflow` accepts `signal` in its options and threads it into every stage spawn, so callers (e.g. codemode timeouts, tool aborts) can cancel a whole workflow.
