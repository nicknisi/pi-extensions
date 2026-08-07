---
'@nicknisi/pi-session-name': patch
'@nicknisi/pi-recap': patch
---

Read config from the real agent dir instead of a hardcoded `~/.pi/agent`.

Both packages built their config path from `os.homedir()`, so anyone running a
non-default agent dir (`PI_CODING_AGENT_DIR`, or a harness that sets it) had
their config silently ignored — and in recap's case, writes landed in the wrong
place too. They now use `getAgentDir()`, like the other packages. recap also
resolves the path per call, so a config it just wrote is visible to the next
read.
