const escape = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export const shellHeaders = {
  'Content-Type': 'text/html; charset=utf-8',
  // Keep Origin on same-origin sign-in/logout form POSTs. Artifact bytes retain no-referrer.
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Frame-Options': 'DENY',
};
export const contentHeaders = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy':
    "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' http: https:; style-src 'unsafe-inline' http: https:; img-src data: http: https:; font-src data: http: https:; connect-src http: https:; media-src http: https:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
};
export function signIn(): string {
  return '<!doctype html><html lang="en"><meta charset="utf-8"><title>Private artifact</title><h1>Private artifact</h1><p>Use the configured Pi Share menu or pi-artifact-host login to sign in for read-only viewing. No publication credential belongs in this page.</p></html>';
}
export function viewer(slug: string, title: string, capability?: string): string {
  const src = capability ? `/_view/${capability}/${slug}/index.html` : `/${slug}/index.html`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{margin:0;font:14px system-ui}header{padding:12px 20px}iframe{display:block;border:0;width:100%;height:calc(100dvh - 110px)}</style><header>${escape(title)}<br><small>${capability ? 'Private, read-only viewing. Asset access expires in five minutes. Reload to renew or sign in again.' : 'Public artifact. Anyone with this link can view it.'}</small><br><a href="/${slug}/">Reload viewer</a>${capability ? '<form action="/owner/logout" method="post"><button>Sign out</button></form>' : ''}</header><iframe title="Artifact document" sandbox="allow-scripts" referrerpolicy="no-referrer" credentialless src="${escape(src)}"></iframe></html>`;
}
