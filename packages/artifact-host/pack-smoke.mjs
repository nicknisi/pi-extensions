import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const pkg = dirname(fileURLToPath(import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'artifact-pack-'));
let child;
function run(command, args, cwd) {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
}
try {
  run('pnpm', ['pack', '--pack-destination', temp], pkg);
  const tar = readdirSync(temp).find((name) => name.endsWith('.tgz'));
  run('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', join(temp, tar)], temp);
  assert(!existsSync(join(temp, 'node_modules/@earendil-works')));
  const token = 'fixture-owner-token-not-a-secret-123456';
  child = spawn(
    process.execPath,
    [
      join(temp, 'node_modules/@nicknisi/pi-artifact-host/dist/cli.js'),
      '--port',
      '0',
      '--data-dir',
      join(temp, 'data'),
    ],
    {
      cwd: temp,
      env: { ...process.env, ARTIFACT_HOST_TOKEN_SHA256: createHash('sha256').update(token).digest('hex') },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('startup timeout')), 10000);
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('CLI exited'));
    });
    child.stdout.on('data', (data) => {
      const match = /port (\d+)/.exec(String(data));
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const form = new FormData();
  form.append('files', new Blob(['<h1>Standalone</h1>'], { type: 'text/html' }), 'hello.html');
  form.append('paths', JSON.stringify(['hello.html']));
  const upload = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  assert.equal(upload.status, 200);
  const { slug, url } = await upload.json();
  assert.equal(url, `${base}/${slug}/`);
  assert.equal((await fetch(url)).status, 401);
  const patch = await fetch(`${base}/api/links/${slug}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'If-Match': '"1"' },
    body: JSON.stringify({ is_public: true }),
  });
  assert.equal(patch.status, 200);
  assert.match(await (await fetch(url)).text(), /sandbox="allow-scripts"/);
  assert.equal(await (await fetch(url + 'index.html')).text(), '<h1>Standalone</h1>');
  assert(existsSync(join(temp, 'node_modules/@nicknisi/pi-artifact-host/openapi.json')));
  console.log('Standalone pack/install/CLI/HTTP smoke passed without Pi installed.');
} finally {
  if (child && child.exitCode === null) {
    const exit = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exit;
  }
  rmSync(temp, { recursive: true, force: true });
}
