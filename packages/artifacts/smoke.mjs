/**
 * Self-check harness for the annotation feature. Plain node ESM, no deps, run
 * from the repo root:
 *
 *   node packages/artifacts/smoke.mjs clean
 *   node packages/artifacts/smoke.mjs persist
 *   node packages/artifacts/smoke.mjs stale
 *   node packages/artifacts/smoke.mjs share
 *
 * Each subcommand is self-contained: it boots the real server from `dist/`
 * against a temp fixture artifact dir and exercises it with `fetch`. Exits
 * non-zero with `FAIL <name>: <why>` on the first failed assertion, otherwise
 * prints `PASS <name>` lines. There is no test runner in this repo.
 */

import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MARKER = 'data-artifact-annotate';
const PASSAGE_A = 'Deploys rose forty percent after the migration.';
const PASSAGE_B = 'The rollback plan was never exercised in staging.';
// Renders with inline markup (<strong>) inside — quotes spanning it must still match.
const PASSAGE_C = 'The migration cut p95 latency by **a third** overall.';
const PASSAGE_C_QUOTE = 'cut p95 latency by a third overall';
// Duplicated verbatim — disambiguation requires context.
const PASSAGE_D = 'Status pages stayed green.';

const SOURCE = `# Sprint Report

${PASSAGE_A}

${PASSAGE_B}

${PASSAGE_C}

${PASSAGE_D}

${PASSAGE_D}
`;

const SOURCE_NO_A = `# Sprint Report

${PASSAGE_B}

${PASSAGE_C}

${PASSAGE_D}

${PASSAGE_D}
`;

function die(name, why) {
  console.error(`FAIL ${name}: ${why}`);
  process.exit(1);
}

function assert(name, cond, why) {
  if (!cond) die(name, why);
}

/**
 * Precondition: dist/ must exist and be newer than the .ts sources, else the
 * script would assert stale build output. Exit 2 tells the operator to build.
 */
function checkBuilt() {
  const distDir = 'packages/artifacts/dist';
  const files = ['server.js', 'feedback.js', 'utils.js', 'templates.js', 'annotate.js'];
  for (const f of files) {
    const dist = join(distDir, f);
    const src = join('packages/artifacts', f.replace(/\.js$/, '.ts'));
    if (!existsSync(dist)) {
      console.error('run pnpm build first');
      process.exit(2);
    }
    if (existsSync(src) && statSync(dist).mtimeMs < statSync(src).mtimeMs) {
      console.error('run pnpm build first');
      process.exit(2);
    }
  }
}

/** mkdtemp + chdir, THEN dynamic-import dist (artifactDir reads process.cwd()). */
async function boot() {
  const tmp = mkdtempSync(join(tmpdir(), 'artifact-smoke-'));
  process.chdir(tmp);
  const root = process.env.SMOKE_REPO_ROOT;
  const base = root ? `${root}/packages/artifacts/dist` : new URL('./dist/', import.meta.url).href;
  const server = await import(`${base}/server.js`);
  const utils = await import(`${base}/utils.js`);
  const templates = await import(`${base}/templates.js`);
  const feedback = await import(`${base}/feedback.js`);
  return { tmp, server, utils, templates, feedback };
}

function writeFixture(utils, templates, slug, title, source) {
  const html = templates.renderMarkdownDocument(title, slug, source);
  utils.writeArtifact(slug, html);
  utils.writeSourceMirror(slug, source);
}

function ann(id, exact, comment, prefix, suffix) {
  const quote = { exact };
  if (prefix) quote.prefix = prefix;
  if (suffix) quote.suffix = suffix;
  return { id, quote, comment, createdAt: new Date().toISOString() };
}

async function urlFor(server, slug) {
  const port = server.runningPort();
  return `http://127.0.0.1:${port}/${slug}.html`;
}

// ─── clean ─────────────────────────────────────────────────────────────────
async function clean() {
  const { server, utils, templates } = await boot();
  const slug = 'sprint-report';
  writeFixture(utils, templates, slug, 'Sprint Report', SOURCE);
  await server.ensureServer();

  const served = await (await fetch(await urlFor(server, slug))).text();
  assert('clean', served.includes(MARKER), 'served page is missing the annotate marker');

  const stored = readFileSync(utils.artifactPath(slug), 'utf-8');
  assert('clean', !stored.includes(MARKER), 'stored file leaked the annotate marker');

  server.stopServer();
  console.log('PASS clean');
}

// ─── persist ─────────────────────────────────────────────────────────────────
async function persist() {
  const { server, utils, templates, feedback } = await boot();
  const slug = 'sprint-report';
  writeFixture(utils, templates, slug, 'Sprint Report', SOURCE);
  await server.ensureServer();

  const list = [ann('a1', PASSAGE_A, 'which migration?'), ann('b1', PASSAGE_B, 'link the runbook')];
  const putRes = await fetch(`http://127.0.0.1:${server.runningPort()}/api/annotations`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, annotations: list }),
  });
  assert('persist', putRes.status === 200, `PUT returned ${putRes.status}`);

  const sidecarPath = utils.annotationsPath(slug);
  assert('persist', existsSync(sidecarPath), 'sidecar was not written');
  const stored = feedback.readAnnotations(slug);
  assert('persist', stored.length === 2, `sidecar has ${stored.length} annotations, want 2`);

  // Reboot: hydration must survive a server restart.
  server.stopServer();
  await server.ensureServer();
  const served = await (await fetch(await urlFor(server, slug))).text();
  // Assert the embedded hydration payload, not the passages — those already
  // appear in the rendered markdown body and would pass vacuously.
  assert(
    'persist',
    served.includes('__ARTIFACT_ANNOTATIONS__') &&
      served.includes('"id":"a1"') &&
      served.includes('"id":"b1"') &&
      served.includes('which migration?') &&
      served.includes('link the runbook'),
    'served page did not embed the sidecar annotations payload',
  );

  const text = feedback.artifactText(slug);
  assert('persist', text !== null, 'artifactText returned null');
  assert(
    'persist',
    !feedback.isStale(list[0], text) && !feedback.isStale(list[1], text),
    'a live quote was marked stale',
  );

  const line = feedback.sourceLine(list[0], slug);
  assert('persist', typeof line === 'number', 'sourceLine did not find a present quote');

  // Comment markdown rendering (annotation UI preview/panel).
  const rendered = await (
    await fetch(`http://127.0.0.1:${server.runningPort()}/api/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: '**bold** <script>alert(1)</script>' }),
    })
  ).json();
  assert('persist', rendered.html.includes('<strong>bold</strong>'), 'render endpoint did not render markdown');
  assert('persist', !rendered.html.includes('<script'), 'render endpoint did not strip script tags');

  server.stopServer();
  console.log('PASS persist');
}

// ─── stale ───────────────────────────────────────────────────────────────────
async function stale() {
  const { server, utils, templates } = await boot();
  const slug = 'sprint-report';
  writeFixture(utils, templates, slug, 'Sprint Report', SOURCE);
  await server.ensureServer();
  const port = server.runningPort();

  // Regression guards (both shipped bugs):
  //  C — quote spans inline markup (<strong>): server tag-stripping must not split it.
  //  E — unique quote with WRONG context: context is advisory for unique matches.
  //  D — duplicated quote with WRONG context: duplicates still require a context match.
  const list = [
    ann('a1', PASSAGE_A, 'which migration?'),
    ann('b1', PASSAGE_B, 'link the runbook'),
    ann('c1', PASSAGE_C_QUOTE, 'crosses bold'),
    ann('e1', 'never exercised in staging', 'unique, bad context', 'zzz wrong context'),
    ann('d1', PASSAGE_D, 'duplicate, bad context', 'zzz no such context'),
  ];
  await fetch(`http://127.0.0.1:${port}/api/annotations`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, annotations: list }),
  });

  // Rewrite the artifact without passage A → A goes stale, B survives.
  writeFixture(utils, templates, slug, 'Sprint Report', SOURCE_NO_A);

  // 503 twin first: no sender registered.
  server.setFeedbackSender(null);
  const noSender = await fetch(`http://127.0.0.1:${port}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug }),
  });
  assert('stale', noSender.status === 503, `expected 503 with no sender, got ${noSender.status}`);
  const noSenderBody = await noSender.json();
  assert('stale', typeof noSenderBody.feedback === 'string', '503 body missing composed feedback');
  assert('stale', existsSync(utils.annotationsPath(slug)), 'sidecar deleted on a failed delivery');

  // Now a capturing sender: delivery succeeds, sidecar deleted.
  let captured = null;
  server.setFeedbackSender((md) => {
    captured = md;
    return true;
  });
  const ok = await fetch(`http://127.0.0.1:${port}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug }),
  });
  assert('stale', ok.status === 200, `expected 200 on delivery, got ${ok.status}`);
  assert('stale', captured !== null, 'sender was never invoked');
  assert('stale', captured.includes(slug), 'message missing the slug');
  assert('stale', captured.includes(`http://127.0.0.1:${port}/${slug}.html`), 'message missing the artifact URL');

  const aLine = captured.split('\n').find((l) => l.includes(PASSAGE_A));
  const bLine = captured.split('\n').find((l) => l.includes(PASSAGE_B));
  assert('stale', aLine && aLine.includes('[stale]'), 'removed passage A was not marked [stale]');
  assert('stale', bLine && !bLine.includes('[stale]'), 'surviving passage B was wrongly marked [stale]');
  const cLine = captured.split('\n').find((l) => l.includes(PASSAGE_C_QUOTE));
  assert('stale', cLine && !cLine.includes('[stale]'), 'quote spanning inline markup was wrongly marked [stale]');
  const eLine = captured.split('\n').find((l) => l.includes('"never exercised in staging"'));
  assert('stale', eLine && !eLine.includes('[stale]'), 'unique quote with noisy context was wrongly marked [stale]');
  const dLine = captured.split('\n').find((l) => l.includes(PASSAGE_D));
  assert('stale', dLine && dLine.includes('[stale]'), 'duplicated quote with mismatched context must be [stale]');
  assert('stale', !existsSync(utils.annotationsPath(slug)), 'sidecar not deleted after successful delivery');

  server.stopServer();
  console.log('PASS stale');
}

// ─── share ───────────────────────────────────────────────────────────────────
async function share() {
  const { server, utils, templates, feedback } = await boot();
  const slug = 'sprint-report';
  writeFixture(utils, templates, slug, 'Sprint Report', SOURCE);
  await server.ensureServer();
  const base = `http://127.0.0.1:${server.runningPort()}`;
  const post = (body) =>
    fetch(`${base}/api/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  // Endpoint validation (the in-page Share button's route).
  assert('share', (await post({ slug: '../x', method: 'copy' })).status === 400, 'bad slug not rejected');
  assert('share', (await post({ slug, method: 'pigeon' })).status === 400, 'bad method not rejected');
  assert('share', (await post({ slug: 'nope', method: 'copy' })).status === 404, 'missing artifact not 404');

  const copyRes = await post({ slug, method: 'copy' });
  assert('share', copyRes.status === 200, `copy returned ${copyRes.status}`);
  const copyBody = await copyRes.json();
  assert('share', copyBody.ok === true && copyBody.bytes > 0, 'copy response missing ok/bytes');

  assert('share', feedback.bakeAnnotations(slug) === null, 'bake should be null with no annotations');

  const list = [ann('a1', PASSAGE_A, 'which migration?'), ann('b1', PASSAGE_B, 'link the runbook')];
  feedback.writeAnnotations(slug, list);
  const baked = feedback.bakeAnnotations(slug);
  assert('share', baked !== null && baked.count === 2, 'bake did not return both comments');
  assert('share', baked.html.includes(MARKER), 'baked file missing the annotation layer');
  assert(
    'share',
    baked.html.includes('"id":"a1"') && baked.html.includes('link the runbook'),
    'baked file missing the annotation payload',
  );
  assert('share', baked.html.includes('STATIC = true'), 'baked file not in static mode');
  assert('share', !readFileSync(utils.artifactPath(slug), 'utf-8').includes(MARKER), 'bake polluted the stored file');

  // Copy endpoint bakes comments when they exist.
  const bakedCopy = await (await post({ slug, method: 'copy' })).json();
  assert('share', bakedCopy.count === 2, `endpoint copy baked ${bakedCopy.count} comments, want 2`);

  server.stopServer();
  console.log('PASS share');
}

const cmd = process.argv[2];
checkBuilt();

const table = { clean, persist, stale, share };
const fn = table[cmd];
if (!fn) {
  console.error(`usage: node packages/artifacts/smoke.mjs <clean|persist|stale|share>`);
  process.exit(2);
}
fn().catch((e) => die(cmd, e && e.stack ? e.stack : String(e)));
