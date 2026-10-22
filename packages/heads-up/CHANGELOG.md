# @nicknisi/pi-heads-up

## 0.2.1

### Patch Changes

- Updated dependencies [245ee0f]
  - @nicknisi/pi-shared@0.8.1

## 0.2.0

### Minor Changes

- 7801bfc: Optional classifier models. heads-up scores each automatic check with a classifier (TypeSafe's Jev by default) in shadow mode, logging the score with each event; `gateEnforce: true` skips checks below `gateThreshold`. answer shows a `? ctrl+. to answer` footer hint after replies a classifier judges to ask you questions. Both behave as before when no classifier is available. pi-shared adds `findClassifier`, `classifyBool`, and `DEFAULT_CLASSIFIERS`.

  heads-up also logs every check, with its side-request cost, and `/heads-up` shows the logged total, since these requests never reach the session cost. The event log keeps 2000 events instead of 500. answer defaults to `claude-haiku-4-5` then `claude-sonnet-5` for extraction instead of Fable 5 and Opus 5, and `/answer` no longer requires a session model.

### Patch Changes

- Updated dependencies [7801bfc]
  - @nicknisi/pi-shared@0.8.0

## 0.1.0

### Minor Changes

- c95fffa: Add heads-up: after long runs, a side agent reads a digest of the session and shows at most one short note, as a bordered card above the editor, about something with consequences you might miss. `alt+h` opens the note's actions (learn more, simpler/shorter/more detail rewrites, make a page, ask in chat, knew this, dismiss); `/heads-up` shows status, toggles it, or forces a check. Ported from the Claude Code heads-up mod.
