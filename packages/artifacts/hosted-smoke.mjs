// Temporary real-host + actual local-server browser playground. No user config changes.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { startHost } from '../artifact-host/dist/index.js';
const scratch = mkdtempSync(join(tmpdir(), 'hosted-browser-'));
const original = process.cwd();
process.env.PI_CODING_AGENT_DIR = join(scratch, 'agent');
const token = 'fixture-owner-token-not-a-secret-123456';
process.env.ARTIFACT_SMOKE_TOKEN = token;
let host, local, notify, publish, config, status;
const dataDir = join(scratch, 'host');
const hostConfig = { dataDir, tokenSha256: createHash('sha256').update(token).digest('hex'), port: 0 };
async function cleanup() {
  local?.stopServer();
  await host?.close();
  process.chdir(original);
  rmSync(scratch, { recursive: true, force: true });
}
try {
  host = await startHost(hostConfig);
  hostConfig.port = host.port;
  mkdirSync(join(scratch, 'agent/configs'), { recursive: true });
  writeFileSync(
    join(scratch, 'agent/configs/artifacts.json'),
    JSON.stringify({
      remote: { url: `http://127.0.0.1:${host.port}`, tokenEnv: 'ARTIFACT_SMOKE_TOKEN', autoSync: true },
    }),
  );
  process.chdir(scratch);
  mkdirSync('.pi/artifacts', { recursive: true });
  const templates = await import('./dist/templates.js');
  local = await import('./dist/server.js');
  notify = local.notifyReload;
  ({ publishArtifact: publish, publicationStatus: status } = await import('./dist/remote.js'));
  ({ CONFIG: config } = await import('./dist/config.js'));
  const path = join(scratch, '.pi/artifacts/smoke.html');
  let revision = 1;
  function write() {
    writeFileSync(
      path,
      templates.renderHtmlDocument(
        'Smoke',
        'smoke',
        `<h1>Browser smoke revision ${revision++}</h1><p id="isolation">Script not run</p><script>try { parent.document.body.dataset.artifactProbe='access'; document.getElementById('isolation').textContent=parent===window?'Direct document':'Parent access allowed (local only)'; } catch { document.getElementById('isolation').textContent='Parent access blocked'; } try { localStorage.setItem('artifactProbe','access'); } catch { document.body.dataset.storageBlocked='yes'; }</script>`,
      ),
    );
  }
  write();
  console.log(
    `Scratch: ${scratch}\nLocal artifact: ${await local.artifactUrl('smoke')}\nHost: http://127.0.0.1:${host.port}\nCommands on stdin: update, stop-host, start-host, private, public, assets, status, quit\nOpen Share (no upload), Publish link, Copy link, then update. Stop host, update, observe unsynced, restart host, Sync now. Use private then update to prove auto-sync does not republish. Use View private (sign in), confirm read-only sign-in, and open the ordinary private URL. Use assets for nested CSS/module/SVG sandbox probes. Open /index.html and /nested/probe.svg directly. No browser evidence is asserted by this harness.`,
  );
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (line === 'quit') break;
    if (line === 'stop-host') {
      await host.close();
      console.log('Host stopped.');
    }
    if (line === 'start-host') {
      host = await startHost(hostConfig);
      console.log('Host restarted on same port and database.');
    }
    if (line === 'status') console.log(status(path, config));
    if (line === 'private' || line === 'public') {
      const current = status(path, config);
      if (!current.viewerUrl) console.log('Publish from Share first.');
      else {
        const slug = new URL(current.viewerUrl).pathname.split('/')[1];
        const response = await fetch(`http://127.0.0.1:${host.port}/api/links/${slug}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_public: line === 'public' }),
        });
        console.log('Visibility:', response.status, await response.json());
      }
    }
    if (line === 'assets') {
      const form = new FormData();
      const files = {
        'index.html':
          '<title>Private asset probe</title><link rel="stylesheet" href="nested/probe.css"><script type="module" src="nested/probe.js"></script><h1>Private assets</h1><p id="probe">Module not loaded</p><img src="nested/probe.svg">',
        'nested/probe.css': 'body{background:#dfe;color:#123;font:20px system-ui}',
        'nested/probe.js':
          'import {message} from "./value.js"; document.querySelector("#probe").textContent=message; try{parent.document.body.dataset.escape="yes"}catch{document.body.dataset.parentBlocked="yes"} try{localStorage.setItem("escape","yes")}catch{document.body.dataset.storageBlocked="yes"}',
        'nested/value.js': 'export const message="Nested module loaded";',
        'nested/probe.svg':
          '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="50"><text y="25">SVG loaded</text><script>try{localStorage.setItem("svgEscape","yes")}catch{document.documentElement.setAttribute("data-storage-blocked","yes")}</script></svg>',
      };
      for (const [name, content] of Object.entries(files))
        form.append('files', new Blob([content]), name.split('/').at(-1));
      form.append('paths', JSON.stringify(Object.keys(files)));
      const uploaded = await (
        await fetch(`http://127.0.0.1:${host.port}/api/upload`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        })
      ).json();
      const ticket = await (
        await fetch(`http://127.0.0.1:${host.port}/api/owner/viewing-tickets`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ return_path: `/${uploaded.slug}/` }),
        })
      ).json();
      console.log(
        'Private asset URL:',
        uploaded.url,
        '\\nSign in within 60 seconds:',
        ticket.url,
        '\\nAfter sign-in use normal private URL. Direct capability HTML/SVG must stay sandboxed.',
      );
    }
    if (line === 'update') {
      write();
      console.log(await publish(path, config, false));
      notify('smoke');
    }
  }
  rl.close();
} finally {
  await cleanup();
}
