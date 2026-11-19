/**
 * Lazy access to the document renderers. templates.ts pulls in marked,
 * diff2html, highlight.js, pele and the embedded reader font, so it is loaded
 * on first render rather than on every pi startup/reload/session switch.
 * One shared promise keeps concurrent first renders in invocation order.
 */
type Templates = typeof import('./templates.js');

let templates: Promise<Templates> | undefined;

export function loadTemplates(): Promise<Templates> {
  return (templates ??= import('./templates.js'));
}
