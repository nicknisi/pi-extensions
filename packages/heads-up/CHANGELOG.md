# @nicknisi/pi-heads-up

## 0.3.6

### Patch Changes

- 3f237a6: Retry on the session model when a configured side model fails at request time (for example a deprecated model returning 410). Adds `withSessionFallback` to `@nicknisi/pi-shared`; recap, heads-up, session-name, answer, and btw now use it instead of surfacing the error.
- Updated dependencies [3f237a6]
  - @nicknisi/pi-shared@0.12.0

## 0.3.5

### Patch Changes

- 6bfdb8e: Panel rewrites that fail now show a warning, a note is cleared when you move to another branch, and `/heads-up check` and `/heads-up show` no longer run outside the TUI. While heads-up is off, long turns no longer re-read the store file every 10 seconds.
- Updated dependencies [6bfdb8e]
  - @nicknisi/pi-shared@0.11.1

## 0.3.4

### Patch Changes

- Updated dependencies [760fe48]
  - @nicknisi/pi-shared@0.11.0

## 0.3.3

### Patch Changes

- Updated dependencies [9ec3ab2]
  - @nicknisi/pi-shared@0.10.1

## 0.3.2

### Patch Changes

- e434bdb: Ship `CHANGELOG.md` in the npm package so pi 1.5 can show what changed under "Extension Updates" after `pi update`.

## 0.3.1

### Patch Changes

- fcb686c: Use credential-aware preferred-model selection with fallback to the current session model across btw, session-name, recap, answer, and heads-up.
- Updated dependencies [fcb686c]
  - @nicknisi/pi-shared@0.10.0

## 0.3.0

### Minor Changes

- 5877c29: Split actionable Heads up warnings from non-urgent Insights, which now appear inline as persistent UI-only transcript entries without requiring dismissal.

### Patch Changes

- 82a1c44: Fall back to the current session model when the configured heads-up model is unavailable or its provider has no credentials.

## 0.2.2

### Patch Changes

- Updated dependencies [a9f4d1a]
- Updated dependencies [15ddcd3]
  - @nicknisi/pi-shared@0.9.0

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
