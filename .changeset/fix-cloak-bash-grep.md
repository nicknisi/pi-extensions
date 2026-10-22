---
'@nicknisi/pi-cloak': minor
---

Redact `bash` and `grep` results, not only `read`. A rule applies to them when the bash command names a file the rule covers (`cat .env`), when grep's `path`/`glob` matches, or always when the rule sets the new `global: true`. Patterns now run over the whole text with the `m` flag, so multi-line secrets such as PEM blocks can match while `^`/`$` stay per-line. A rule with an invalid regex is skipped and reported instead of disabling every rule. A config file that exists but can't be parsed now withholds tool output (fails closed); a missing config file still passes output through. Errors are written to stderr when there's no UI.
