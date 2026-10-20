/**
 * Browser end-to-end check for the review page. Plain node ESM, no deps; run
 * from the repo root after `pnpm build`:
 *
 *   node packages/artifacts/e2e.mjs
 *
 * Boots the real server from `dist/` against a temp artifact dir, drives
 * headless Chrome over CDP with real mouse and keyboard input inside the
 * artifact's cross-origin frame, and checks what reaches the agent. It runs
 * twice: once where Chrome gives each artifact its own `<label>.localhost`
 * origin, once with that host unresolvable (as in Safari), where artifacts
 * fall back to a sandboxed opaque origin. Each run also checks that a forging
 * script in the artifact can neither write to the API nor read another
 * artifact. Set CHROME_PATH to pick a browser; without one it skips.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 'boot';
function assert(cond, why) {
  if (!cond) {
    console.error(`FAIL ${step}: ${why}`);
    process.exit(1);
  }
}
async function waitFor(fn, why, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    assert(Date.now() < end, `timed out waiting for ${why}`);
    await sleep(100);
  }
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(mac)) return mac;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    if (spawnSync('which', [name]).status === 0) return name;
  }
  return null;
}

// ─── CDP ───────────────────────────────────────────────────────────────────
async function launch(chromePath, extraArgs) {
  const profile = mkdtempSync(join(tmpdir(), 'artifact-e2e-chrome-'));
  const proc = spawn(
    chromePath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...extraArgs,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const portFile = join(profile, 'DevToolsActivePort');
  await waitFor(async () => existsSync(portFile) && readFileSync(portFile, 'utf8').includes('\n'), 'Chrome to start');
  const [port, path] = readFileSync(portFile, 'utf8').split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const wait = pending.get(m.id);
    if (wait) {
      pending.delete(m.id);
      if (m.error) wait.reject(new Error(`${wait.method}: ${m.error.message}`));
      else wait.resolve(m.result);
    } else listeners.forEach((fn) => fn(m));
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject, method });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const close = async () => {
    ws.close();
    if (proc.exitCode === null) await new Promise((r) => (proc.once('exit', r), proc.kill()));
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  return { send, on: (fn) => listeners.push(fn), close };
}

/** A 1440×900 page whose artifact frame (an out-of-process iframe) is reachable too. */
async function openPage(chrome) {
  const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: page } = await chrome.send('Target.attachToTarget', { targetId, flatten: true });
  const tab = { page, frame: null };
  chrome.on((m) => {
    if (m.method === 'Target.attachedToTarget' && m.sessionId === page && m.params.targetInfo.type === 'iframe') {
      tab.frame = m.params.sessionId;
      chrome.send('Runtime.runIfWaitingForDebugger', {}, tab.frame).catch(() => {});
    }
  });
  await chrome.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
    page,
  );
  await chrome.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, page);
  const evaluate = async (session, expression) => {
    const r = await chrome.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  tab.inPage = (expression) => evaluate(tab.page, expression);
  tab.inFrame = (expression) => evaluate(tab.frame, expression);
  tab.goto = async (url) => {
    tab.frame = null;
    await chrome.send('Page.navigate', { url }, page);
    // The bridge says hello once the panel has the document's colors.
    await waitFor(
      () => tab.inPage('document.documentElement.style.getPropertyValue("--aa-bg") !== "" || null'),
      'the bridge',
    );
    await waitFor(async () => tab.frame && (await tab.inFrame('document.readyState === "complete"')), 'the frame');
  };
  // The panel animates the frame's width; measure only once it holds still.
  const settle = async () => {
    const box = () => tab.inPage('JSON.stringify(document.getElementById("artifact-frame").getBoundingClientRect())');
    let last = await box();
    for (let i = 0; i < 50; i++) {
      await sleep(120);
      const now = await box();
      if (now === last) return;
      last = now;
    }
  };
  // Page coordinates of a point inside the frame: its viewport offset plus the iframe's box.
  const toPage = async (x, y) => {
    const [left, top] = await tab.inPage(
      '(() => { const f = document.getElementById("artifact-frame"), r = f.getBoundingClientRect(); return [r.left + f.clientLeft, r.top + f.clientTop]; })()',
    );
    return [left + x, top + y];
  };
  const mouse = (type, x, y, extra = {}) =>
    chrome.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra }, page);
  tab.click = async (selector) => {
    await settle();
    const [x, y] = await tab.inFrame(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`,
    );
    const [px, py] = await toPage(x, y);
    await mouse('mousePressed', px, py);
    await mouse('mouseReleased', px, py);
  };
  tab.select = async (phrase) => {
    await settle();
    const [x1, y1, x2, y2] = await tab.inFrame(`(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n; (n = walker.nextNode()); ) {
        const at = n.data.indexOf(${JSON.stringify(phrase)});
        if (at === -1) continue;
        n.parentElement.scrollIntoView({ block: "center" });
        const range = document.createRange();
        range.setStart(n, at); range.setEnd(n, at + ${phrase.length});
        const rects = range.getClientRects(), a = rects[0], b = rects[rects.length - 1];
        return [a.left + 1, a.top + a.height / 2, b.right - 1, b.top + b.height / 2];
      }
    })()`);
    const [sx, sy] = await toPage(x1, y1);
    const [ex, ey] = await toPage(x2, y2);
    await mouse('mousePressed', sx, sy);
    await mouse('mouseMoved', ex, ey, { buttons: 1 });
    await mouse('mouseReleased', ex, ey);
  };
  tab.type = (text) => chrome.send('Input.insertText', { text }, page);
  tab.press = (label) =>
    tab.inPage(
      `[...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)}) && b.offsetParent).click()`,
    );
  return tab;
}

// ─── fixtures ──────────────────────────────────────────────────────────────
const PHRASE = 'rose sharply after the migration';

/** Raw HTML a Markdown artifact may carry: tries to act as the reviewer and to read another artifact. */
function forgeScript(port, otherOrigin) {
  return `<img alt="" src="data:," onerror="(async () => {
    const out = [];
    const t = async (name, call) => { try { const r = await call(); out.push(name + ':' + r.status); } catch (_) { out.push(name + ':blocked'); } };
    const json = { 'Content-Type': 'application/json' };
    await t('put', () => fetch('http://127.0.0.1:${port}/api/annotations', { method: 'PUT', headers: json, body: JSON.stringify({ slug: 'iso', annotations: [{ id: 'forged', comment: 'FORGED', createdAt: 'now' }] }) }));
    await t('send', () => fetch('http://127.0.0.1:${port}/api/feedback', { method: 'POST', headers: json, body: JSON.stringify({ slug: 'iso' }) }));
    await t('other-path', () => fetch('/c/other.html'));
    await t('other-origin', () => fetch('${otherOrigin}/c/other.html'));
    document.documentElement.dataset.forge = out.join(' ');
  })()">`;
}

async function boot() {
  const tmp = mkdtempSync(join(tmpdir(), 'artifact-e2e-'));
  process.chdir(tmp);
  const dist = new URL('./dist/', import.meta.url).href;
  const server = await import(`${dist}server.js`);
  const utils = await import(`${dist}utils.js`);
  const templates = await import(`${dist}templates.js`);
  const review = await import(`${dist}review.js`);
  const port = await server.ensureServer();
  const otherOrigin = await server.contentOrigin('other');
  const source = `# Isolation check

The deploy rate ${PHRASE}, which nobody expected.

| Service | p95 |
| --- | --- |
| api | 120ms |

${forgeScript(port, otherOrigin)}
`;
  const iso = review.renderReviewContent(
    templates.renderMarkdownDocument('Isolation check', 'iso', source),
    [
      {
        id: 'storage',
        question: 'Which storage?',
        options: [
          { value: 'sqlite', label: 'SQLite' },
          { value: 'postgres', label: 'Postgres' },
        ],
      },
    ],
    [],
  );
  utils.writeArtifact('iso', iso);
  utils.writeSourceMirror('iso', source);
  utils.writeArtifact('other', templates.renderMarkdownDocument('Other', 'other', '# Other\n\nSecret plans.'));
  const delivered = [];
  server.setFeedbackSender((text) => delivered.push(text));
  return { tmp, server, utils, port, delivered };
}

// ─── the run ───────────────────────────────────────────────────────────────
async function run(name, chromePath, extraArgs, env) {
  const chrome = await launch(chromePath, extraArgs);
  try {
    const tab = await openPage(chrome);
    step = `${name}: open`;
    await tab.goto(`http://127.0.0.1:${env.port}/iso.html`);
    const src = await tab.inPage('document.getElementById("artifact-frame").src');
    const sandbox = await tab.inPage('document.getElementById("artifact-frame").getAttribute("sandbox")');
    if (name === 'own-origin') {
      assert(/^http:\/\/[0-9a-f]{16}\.localhost:\d+\/c\/iso\.html$/.test(src), `frame not on its own origin: ${src}`);
      assert(sandbox.includes('allow-same-origin'), 'own origin lost allow-same-origin');
    } else {
      assert(src === `http://localhost:${env.port}/c/iso.html`, `frame not on the fallback host: ${src}`);
      assert(!sandbox.includes('allow-same-origin'), 'fallback frame is not sandboxed into an opaque origin');
      assert((await tab.inFrame('String(window.origin)')) === 'null', 'fallback frame origin is not opaque');
    }

    step = `${name}: forge`;
    const forge = await waitFor(() => tab.inFrame('document.documentElement.dataset.forge'), 'the forging script');
    assert(!/:2\d\d/.test(forge), `an artifact script got through: ${forge}`);
    const sidecar = env.utils.annotationsPath('iso');
    assert(!existsSync(sidecar) || !readFileSync(sidecar, 'utf8').includes('FORGED'), 'a forged draft was saved');
    assert(env.delivered.length === 0, 'something was delivered on page load');

    step = `${name}: comment on a selection`;
    await tab.inPage('document.getElementById("artifact-annotate-btn").click()');
    await tab.select(PHRASE);
    await waitFor(
      async () => (await tab.inPage('document.querySelector(".pop-quote")?.textContent ?? ""')).includes(PHRASE),
      'the composer to quote the selection',
    );
    await tab.type('Which migration?');
    await tab.press('Add to review');

    step = `${name}: pin`;
    await tab.press('Pin a visual');
    await tab.click('table');
    await waitFor(
      async () => (await tab.inPage('document.querySelector(".pop-quote")?.textContent ?? ""')) === 'Pinned: table',
      'the pin',
    );
    await tab.type('Add a p99 column.');
    await tab.press('Add to review');

    step = `${name}: decision`;
    await tab.click('input[value="postgres"]');
    await waitFor(
      () => tab.inPage('document.body.textContent.includes("Which storage?: Postgres") || null'),
      'the decision draft',
    );

    step = `${name}: send`;
    await tab.press('Send review');
    const text = await waitFor(async () => env.delivered.at(-1), 'delivery');
    for (const want of [PHRASE, 'Which migration?', 'Element: table', 'Add a p99 column.', 'Which storage?: Postgres'])
      assert(text.includes(want), `delivered message lacks ${JSON.stringify(want)}`);
    assert(!text.includes('FORGED'), 'delivered message carries forged text');
    const shots = [...text.matchAll(/Screenshot: (.+\.png)/g)].map((m) => m[1]);
    assert(shots.length === 2, `expected 2 screenshots, got ${shots.length}`);
    for (const shot of shots) assert(readFileSync(shot).subarray(1, 4).toString() === 'PNG', `${shot} is not a PNG`);
    env.delivered.length = 0;

    step = `${name}: reader theme follows you to the next artifact`;
    const before = await tab.inFrame('document.documentElement.dataset.readerTheme');
    await tab.click('button[data-reader-theme]');
    const picked = await waitFor(async () => {
      const now = await tab.inFrame('document.documentElement.dataset.readerTheme');
      return now !== before && now;
    }, 'the theme toggle');
    await tab.goto(`http://127.0.0.1:${env.port}/other.html`);
    await waitFor(
      async () => (await tab.inFrame('document.documentElement.dataset.readerTheme')) === picked,
      `theme ${picked} in the next artifact`,
    );

    if (name === 'own-origin') {
      // Image/PDF shares render this URL in headless Chrome (not run here: they write the clipboard).
      step = `${name}: share render`;
      await chrome.send(
        'Page.navigate',
        { url: `${await env.server.contentOrigin('iso')}/c/iso.html?panel=open` },
        tab.page,
      );
      await waitFor(
        () =>
          tab.inPage(
            'document.querySelectorAll("#artifact-annotate-panel .item").length === 3 && (CSS.highlights.get("artifact-comment")?.size ?? 0) > 0',
          ),
        'the share render with the sent review',
      );
    }
    console.log(`PASS ${name}`);
  } finally {
    await chrome.close();
  }
}

const chromePath = findChrome();
if (!chromePath) {
  console.log('SKIP e2e: no Chrome found (set CHROME_PATH)');
  process.exit(0);
}
if (!existsSync(new URL('./dist/server.js', import.meta.url))) {
  console.error('run pnpm build first');
  process.exit(2);
}
const env = await boot();
try {
  await run('own-origin', chromePath, [], env);
  // Safari can't resolve <label>.localhost; make Chrome fail the same way.
  await run('fallback', chromePath, ['--host-resolver-rules=MAP *.localhost ~NOTFOUND'], env);
} finally {
  env.server.stopServer();
  process.chdir(tmpdir());
  rmSync(env.tmp, { recursive: true, force: true });
}
process.exit(0);
