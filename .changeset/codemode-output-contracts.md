---
'@nicknisi/pi-codemode': minor
---

codemode spawn() now requires an explicit output contract. A spawn with neither `outputSchema` nor `text: true` throws immediately instead of returning unparsed text. This prevents the silent failure mode where reading a field off unparsed text yields `undefined` while the run reports success. A schema-validating spawn that fails validation after its bounded repair attempt still returns `{ ok: false, kind: 'schema_invalid' }` — never a silently-empty string. Migration: add `text: true` to existing text-mode spawns, or define an `outputSchema`.
