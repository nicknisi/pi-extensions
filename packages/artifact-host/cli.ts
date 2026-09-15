#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { startHost } from './index.js';
import { canonicalOrigin } from './host.js';
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      host: { type: 'string' },
      port: { type: 'string' },
      'data-dir': { type: 'string' },
      'canonical-url': { type: 'string' },
      'owner-email': { type: 'string' },
      url: { type: 'string' },
      'return-path': { type: 'string' },
      'token-env': { type: 'string' },
    },
  });
  if (values.help)
    console.log(
      'pi-artifact-host [--host 127.0.0.1] [--port 8080] [--data-dir ./data] [--canonical-url https://artifacts.example] [--owner-email owner@example]\nRequires Node 24+ and ARTIFACT_HOST_TOKEN_SHA256.\npi-artifact-host login --url https://artifacts.example --return-path /SLUG/ [--token-env ARTIFACT_OWNER_TOKEN]\nLogin prints a one-time, read-only sign-in URL. Open it and confirm sign-in.',
    );
  else if (positionals[0] === 'login') {
    const origin = canonicalOrigin(values.url ?? process.env.ARTIFACT_HOST_CANONICAL_URL ?? '');
    const token = process.env[values['token-env'] ?? 'ARTIFACT_OWNER_TOKEN'];
    if (!token || !/^[A-Za-z0-9_-]{32,512}$/.test(token)) throw new Error('Missing or invalid owner credential');
    const target = values['return-path'];
    if (!target || !/^\/[a-z0-9]{8,16}\/$/.test(target)) throw new Error('A /SLUG/ return path is required');
    const response = await fetch(origin + '/api/owner/viewing-tickets', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ return_path: target }),
    });
    if (!response.ok || !response.body) throw new Error('Viewing sign-in request failed');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        size += r.value.length;
        if (size > 8192) throw new Error('Invalid viewing response');
        chunks.push(r.value);
      }
    } finally {
      await reader.cancel();
    }
    const result = JSON.parse(Buffer.concat(chunks).toString()) as { url?: string };
    if (
      typeof result.url !== 'string' ||
      !result.url.startsWith(origin + '/owner/sign-in?ticket=') ||
      !/^[a-f0-9]{64}$/.test(result.url.split('ticket=')[1] ?? '')
    )
      throw new Error('Invalid viewing response');
    console.log(result.url);
  } else {
    if (positionals.length) throw new Error('Unknown command');
    const host = await startHost({
      host: values.host ?? process.env.ARTIFACT_HOST_HOST ?? '127.0.0.1',
      port: Number(values.port ?? process.env.ARTIFACT_HOST_PORT ?? 8080),
      dataDir: values['data-dir'] ?? process.env.ARTIFACT_HOST_DATA_DIR ?? './data',
      tokenSha256: process.env.ARTIFACT_HOST_TOKEN_SHA256 ?? '',
      canonicalUrl: values['canonical-url'] ?? process.env.ARTIFACT_HOST_CANONICAL_URL,
      ownerEmail: values['owner-email'] ?? process.env.ARTIFACT_HOST_OWNER_EMAIL,
    });
    console.log(`Artifact host listening on port ${host.port}`);
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, () => {
        void host.close();
      });
  }
} catch (e) {
  console.error(
    e instanceof Error && /Incompatible development database/.test(e.message)
      ? e.message
      : 'Artifact host command failed. Check configuration, credentials, port and data directory.',
  );
  process.exitCode = 1;
}
