---
'@nicknisi/pi-codemode': patch
---

Fix `Dynamic require of "node:fs" is not supported` errors in codemode snippets.

Snippets that used CJS `require('node:...')` (which the tool description advertises as reachable) failed at runtime: esbuild bundles to ESM and rewrites those calls to a `__require` shim that throws when `require` is undefined in ESM scope. Inject a real CJS `require` (via `createRequire(import.meta.url)`) as an esbuild banner so the shim resolves to the genuine Node built-in instead of throwing.
