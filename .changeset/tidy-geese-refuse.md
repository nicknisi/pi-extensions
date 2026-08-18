---
'@nicknisi/pi-relay': patch
---

Fail relay load with a clear error on Bun <= 1.3.14 instead of letting koffi's GC finalizer abort the process (oven-sh/bun#39263, fixed upstream after 1.3.14); newer Bun and Node load normally
