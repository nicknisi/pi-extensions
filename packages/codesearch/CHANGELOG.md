# @nicknisi/pi-codesearch

## 0.2.1

### Patch Changes

- 561fad7: Declare `typebox` as a `"*"` peer dependency instead of a direct dependency so pi's host-provided copy is used (fixes the extension loader warning about duplicate runtime modules).

## 0.2.0

### Minor Changes

- fa67d94: Add public GitHub code search through grep.app and file fetching by ref and line range, with bounded output and cancellation. Retain upstream attribution without depending on dot-pi.
