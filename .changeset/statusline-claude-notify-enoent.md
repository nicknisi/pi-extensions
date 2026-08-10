---
'@nicknisi/pi-statusline': patch
---

Guard the optional `claude-notify` spawn so a missing binary no longer kills pi with an uncaught `ENOENT`.

The `agent_end` handler spawned `claude-notify waiting <session> <pane>` with `detached: true` and `stdio: 'ignore'`, then immediately `.unref()`'d the returned `ChildProcess` without attaching an `error` listener. When `claude-notify` is not on `PATH`, Node emits `ENOENT` asynchronously on the child's `error` event; with no listener that escalates to an uncaught exception and takes the whole pi process down. `stdio: 'ignore'` does not suppress spawn `error` events.

Attach an empty `error` listener so the failure is swallowed: behavior is unchanged when `claude-notify` exists, and a missing optional notifier can no longer crash pi.
