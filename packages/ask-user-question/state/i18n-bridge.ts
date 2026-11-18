/**
 * i18n bridge for rpiv-ask-user-question — single thin import surface so every
 * call site routes through one place. Backed by `@juicesharp/rpiv-i18n`'s SDK
 * when available; degrades to canonical-English fallbacks when not.
 *
 * - `t(key, fallback)` is `scope("@juicesharp/rpiv-ask-user-question")` if the
 *   SDK is installed (live `/languages` updates propagate). If the SDK is
 *   missing (standalone install without rpiv-i18n), `t` is an identity
 *   passthrough that returns the inline English fallback at every call site,
 *   so the extension stays online with English UI.
 * - `displayLabel(kind)` resolves a sentinel kind to its locale-aware label,
 *   with the canonical English `ROW_INTENT_META[kind].label` as fallback so
 *   nothing renders blank if the namespace isn't registered.
 *
 * Strings are registered ONCE at extension load (see ../index.ts). Call sites
 * MUST use this module at render time — never bake the result into a top-level
 * `const X = displayLabel(...)`.
 *
 * Reserved-label validation stays English-locked: `RESERVED_LABEL_SET` checks
 * the canonical `ROW_INTENT_META[kind].label`, never `displayLabel(kind)`.
 */

import { ROW_INTENT_META, type SentinelKind } from './row-intent.js';

export const I18N_NAMESPACE = '@juicesharp/rpiv-ask-user-question';

type ScopeFn = (key: string, fallback: string) => string;
type I18nSDK = { scope: (namespace: string) => ScopeFn };

// Prefer the live SDK if installed: closures it returns track the active
// locale, so /languages picker propagates to our render call sites. If the
// SDK isn't installed (standalone install of this extension without
// rpiv-i18n), the dynamic import fails, every t(key, fallback) returns the
// canonical English literal, and the extension stays online.
//
// Top-level await is required so a synchronous `t(...)` call from any
// downstream module sees the resolved scope; ESM module loading awaits this
// before evaluating any importer.
// A variable specifier keeps this optional peer out of the type graph: it ships raw .ts, which this repo's build can't compile.
const I18N_SDK: string = '@juicesharp/rpiv-i18n';
/**
 * True only when the module that couldn't be found is the optional SDK itself (the normal case),
 * not one of its own dependencies (installed but broken, which should be reported). Node, jiti and
 * Vite all quote the missing target right after the phrase; an "imported from" path that merely
 * contains the SDK's name is not the target.
 */
function isMissingModule(error: unknown): boolean {
  const target = /(?:Cannot find (?:module|package)|Could not resolve) ['"]([^'"]+)['"]/.exec(String(error))?.[1];
  return target === I18N_SDK || target?.startsWith(`${I18N_SDK}/`) === true;
}
let scopeImpl: ScopeFn;
try {
  const sdk = (await import(I18N_SDK)) as I18nSDK;
  scopeImpl = sdk.scope(I18N_NAMESPACE);
} catch (error) {
  // Fork: absent is silent (English UI); installed-but-broken is reported.
  if (!isMissingModule(error))
    console.warn(`ask-user-question: ${I18N_SDK} failed to load, using English — ${String(error)}`);
  scopeImpl = (_key, fallback) => fallback;
}

export const t: ScopeFn = scopeImpl;
export { isMissingModule };

export function displayLabel(kind: SentinelKind): string {
  return t(`sentinel.${kind}`, ROW_INTENT_META[kind].label);
}
