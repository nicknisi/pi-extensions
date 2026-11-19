# @nicknisi/pi-backtick-guard

## 0.1.1

### Patch Changes

- 6bfdb8e: The bash 3.2 heredoc hint now also appears for `$(cat<<'EOF' ...)` written without a space before `<<`.

## 0.1.0

### Minor Changes

- d0a7cb0: New package: refuses `bash` tool calls whose backtick command substitutions bash would run (for example a Markdown code span inside a double-quoted PR body), using the `mvdan/sh` parser via `sh-syntax`. Backticks in single quotes, quoted heredocs, comments and escapes still run. When macOS `/bin/bash` 3.2 fails on an apostrophe in a heredoc inside `$(...)`, the error gets a hint to pass the text from a file instead. Ported from fitchmultz/pi-fitch-kit.
