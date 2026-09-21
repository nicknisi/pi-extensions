#!/usr/bin/env node
/**
 * Bounded real-model acceptance driver for self-compaction.
 *
 * Launches an actual Pi process with ONLY the self-compact extension loaded,
 * observes the JSON event protocol, and verifies that a fresh handoff produces
 * the exact requested file through an autonomous continuation — without a second
 * human prompt, and without replaying on reload. It fails closed: missing
 * credentials, an unsupported runtime/model, a timeout, a skipped required
 * scenario, or incorrect evidence all exit nonzero. A scripted provider can
 * never satisfy the live contract; the `--self-test` mode below only proves the
 * driver's own assertion/timeout logic rejects wrong behavior.
 *
 * Usage:
 *   node packages/checkpoint/verify/live.mjs            # self-test + live
 *   node packages/checkpoint/verify/live.mjs --self-test  # deterministic self-test only (no spend)
 *   node packages/checkpoint/verify/live.mjs --live-only   # skip self-test (assumes it already ran)
 *
 * Provider/model: prefers SELF_COMPACT_LIVE_PROVIDER/MODEL, else PI_PROVIDER/
 * PI_MODEL. Auth is resolved by Pi itself; this script never reads or prints
 * credentials. The sanitized report is written to verify/results/live.json.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const CLI = join(PKG, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
const SELF_COMPACT_EXT = join(PKG, 'extensions', 'self-compact', 'self-compact.ts');
const HARNESS_EXT = join(HERE, 'cli-harness.ts');
const RESULTS_DIR = join(HERE, 'results');
const RESULT_TXT = join(PKG, 'result.txt');
const OWNER_FILE = join(RESULTS_DIR, 'result-owner.json');
const REPORT_FILE = join(RESULTS_DIR, 'live.json');
const LIVE_SESSION_DIR = join(RESULTS_DIR, 'live-session');
const LIVE_AGENT_DIR = join(RESULTS_DIR, 'live-agent');
const MIN_VERSION = '0.86.1';
const EXPECTED_BYTES = 'done';
// Window-independent thresholds that always resolve to a valid ordering, so the
// fail-closed gate never blocks the flow regardless of the model window. The
// handoff here is driven by an explicit self_compact call, not by a threshold.
const LIVE_FLAGS = ['--compact-soft-at', '50%', '--compact-at', '70%', '--compact-buffer', '10%'];

const LIVE_TASK = [
  'You are running an automated checkpoint acceptance test. Do exactly the following and nothing else.',
  '',
  '1. As your ONLY action this turn, call the self_compact tool. Set note_to_self to exactly this sentence:',
  '   Write the file result.txt in the current working directory with the exact contents done (four lowercase letters, no trailing newline).',
  '   Do not pair self_compact with any other tool call. Do not write result.txt yet.',
  '2. After the session is compacted you will be resumed with that note. At that point use the write tool once to create result.txt with the exact contents: done',
  '   (exactly four bytes, no quotes, no trailing newline). Then reply that the task is complete.',
  '',
  'Do not ask questions. Do not create result.txt before calling self_compact.',
].join('\n');

const COMPLETED_NOTE =
  'The task is complete: result.txt contains exactly done. There are no unfinished actions. Do not rewrite any file or restart the task; report completion.';
const COMPLETED_TASK_PROBE = [
  'The previous task is already complete. As your only action, call self_compact with note_to_self exactly:',
  COMPLETED_NOTE,
  'After compaction, follow that saved note without repeating completed work.',
].join('\n');

// ---------------------------------------------------------------------------
// Process launch + JSON event parsing
// ---------------------------------------------------------------------------

/** Spawn a Pi process to completion with a hard timeout and process-tree kill. */
function spawnPi({ args, env = {}, cwd, timeoutMs, input, stopAfterInfo = false }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let requestedStop = false;
    if (input !== undefined) child.stdin.write(input);
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
      if (
        stopAfterInfo &&
        !requestedStop &&
        parseEvents(stdout).some(
          (e) =>
            e.type === 'extension_ui_request' && e.method === 'notify' && e.message?.startsWith('self-compact info:'),
        )
      ) {
        requestedStop = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: null, stdout, stderr: `${stderr}\n${String(err)}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, stdout, stderr, timedOut, requestedStop });
    });
  });
}

/** Parse newline-framed JSON events, tolerating non-JSON lines (spec framing). */
function parseEvents(stdout) {
  const events = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Not a JSON event line (e.g. arbitrary content); ignore per framing rule.
    }
  }
  return events;
}

/** Does a write/edit tool call target the expected result file? */
function targetsResult(toolName, args, targetPath, cwd) {
  if (toolName !== 'write' && toolName !== 'edit') return false;
  const p = args && typeof args.path === 'string' ? args.path : undefined;
  if (p === undefined) return false;
  const absArg = resolve(cwd, p);
  if (absArg === targetPath) return true;
  // Fallback for disposable temp cwds where the exact abs path is not pinned.
  return p === 'result.txt' || p.endsWith('/result.txt');
}

/** Reduce a JSON event stream to the evidence the assertions consume. */
function collectEvidence(events, { targetPath, cwd }) {
  const selfCompactNotes = [];
  const resultWrites = [];
  let agentStarts = 0;
  const compactionEnds = [];
  const continuationNotes = [];
  const statePhases = [];
  let deliveredEntries = 0;
  let settled = false;
  let sawSessionEvent = false;
  let latestCompletedCycles;

  for (const e of events) {
    switch (e.type) {
      case 'session':
        sawSessionEvent = true;
        break;
      case 'agent_start':
        agentStarts += 1;
        break;
      case 'agent_settled':
        settled = true;
        break;
      case 'compaction_end':
        compactionEnds.push({ aborted: e.aborted === true, hasSummary: !!(e.result && e.result.summary) });
        break;
      case 'tool_execution_start': {
        const name = e.toolName;
        const args = e.args ?? {};
        if (name === 'self_compact') {
          selfCompactNotes.push(typeof args.note_to_self === 'string' ? args.note_to_self : null);
        } else if (targetsResult(name, args, targetPath, cwd)) {
          resultWrites.push({ name, path: args.path });
        }
        break;
      }
      case 'message_start': {
        const m = e.message;
        if (m && m.role === 'custom' && m.customType === 'self-compact:continuation' && typeof m.content === 'string') {
          continuationNotes.push(m.content);
        }
        break;
      }
      case 'entry_appended': {
        const entry = e.entry;
        if (entry && entry.type === 'custom' && entry.customType === 'self-compact:state' && entry.data) {
          statePhases.push(entry.data.phase);
          if (typeof entry.data.completedCycles === 'number') latestCompletedCycles = entry.data.completedCycles;
        } else if (entry && entry.type === 'custom' && entry.customType === 'self-compact:delivered') {
          deliveredEntries += 1;
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    selfCompactNotes,
    resultWrites,
    agentStarts,
    compactionEnds,
    continuationNotes,
    statePhases,
    deliveredEntries,
    settled,
    sawSessionEvent,
    latestCompletedCycles,
    finalPhase: statePhases.length > 0 ? statePhases[statePhases.length - 1] : undefined,
  };
}

function readBytes(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/**
 * Evaluate a fresh continuation run. Returns { ok, failures } — a wrong provider
 * (never writes / writes `done\n` / rewrites / never settles) MUST produce
 * failures, which is what the self-test verifies before any live spend.
 */
function evaluateContinuation({ ev, timedOut, exitCode, fileBytes }) {
  const failures = [];
  if (timedOut) failures.push('run timed out before settling (never treat a quiet timeout as success)');

  const note = ev.selfCompactNotes.find((n) => typeof n === 'string' && n.trim().length > 0);
  if (ev.selfCompactNotes.length === 0) failures.push('no self_compact tool call was made');
  else if (note === undefined) failures.push('self_compact was called without a valid non-blank note_to_self');

  const goodCompaction = ev.compactionEnds.some((c) => !c.aborted && c.hasSummary);
  if (!goodCompaction) failures.push('no successful compaction (compaction_end aborted or missing summary)');

  if (ev.agentStarts < 2) {
    failures.push(`expected an autonomous continuation turn (agent_start >= 2), saw ${ev.agentStarts}`);
  }

  if (note !== undefined) {
    const delivered = ev.continuationNotes.some((c) => c.includes(note));
    if (!delivered) failures.push('the saved note was not delivered verbatim in a continuation message');
  } else if (ev.continuationNotes.length === 0) {
    failures.push('no self-compact continuation message was delivered');
  }

  if (ev.resultWrites.length === 0) failures.push('no real write tool call targeted result.txt');
  else if (ev.resultWrites.length > 1) {
    failures.push(`result.txt was written ${ev.resultWrites.length} times (expected exactly one, no duplicate write)`);
  }

  if (ev.deliveredEntries !== 1)
    failures.push(`expected exactly one delivered handoff cycle, saw ${ev.deliveredEntries}`);
  if (ev.finalPhase !== 'delivered')
    failures.push(`final handoff phase is ${ev.finalPhase ?? 'none'} (expected delivered)`);
  if (ev.latestCompletedCycles !== 1) {
    failures.push(`expected completedCycles === 1, saw ${ev.latestCompletedCycles ?? 'none'}`);
  }

  if (fileBytes === null) failures.push('result.txt does not exist after the run');
  else if (fileBytes !== EXPECTED_BYTES) {
    failures.push(
      `result.txt bytes are ${JSON.stringify(fileBytes)} (expected exactly ${JSON.stringify(EXPECTED_BYTES)})`,
    );
  }

  if (!timedOut && exitCode !== 0) failures.push(`process exited with code ${exitCode} (expected 0)`);

  return { ok: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Deterministic self-test (offline faux provider) — wrong behavior must FAIL
// ---------------------------------------------------------------------------

const assistantToolCall = (name, args) => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id: `c-${name}-${Math.random().toString(36).slice(2, 8)}`, name, arguments: args }],
});
const assistantText = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const SUMMARY = assistantText('## Goal\nWrite result.txt.\n\n## Next Steps\n1. write result.txt with done');
const NOTE = 'Write result.txt with done';

async function runFauxScenario({ responses, timeoutMs = 60000 }) {
  const cwd = mkdtempSync(join(tmpdir(), 'self-compact-live-selftest-'));
  const agentDir = join(cwd, 'agent');
  mkdirSync(agentDir, { recursive: true });
  const responsesPath = join(agentDir, 'faux-responses.json');
  writeFileSync(responsesPath, JSON.stringify(responses));
  writeFileSync(
    join(agentDir, 'settings.json'),
    JSON.stringify({ compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1 }, retry: { enabled: false } }),
  );
  const args = [
    '-p',
    '--mode',
    'json',
    '--provider',
    'faux',
    '--model',
    'faux-1',
    '--session-dir',
    join(cwd, '.sessions'),
    '--offline',
    '--no-context-files',
    '-ne',
    '-e',
    HARNESS_EXT,
    '-e',
    SELF_COMPACT_EXT,
    ...LIVE_FLAGS,
    'Begin the long task.',
  ];
  const run = await spawnPi({
    args,
    cwd,
    timeoutMs,
    env: {
      PI_CODING_AGENT_DIR: agentDir,
      SELF_COMPACT_FAUX_RESPONSES: responsesPath,
      SELF_COMPACT_FAUX_CONTEXT_WINDOW: '200000',
      PI_OFFLINE: '1',
    },
  });
  const ev = collectEvidence(parseEvents(run.stdout), { targetPath: join(cwd, 'result.txt'), cwd });
  const fileBytes = readBytes(join(cwd, 'result.txt'));
  const verdict = evaluateContinuation({ ev, timedOut: run.timedOut, exitCode: run.exitCode, fileBytes });
  rmSync(cwd, { recursive: true, force: true });
  return verdict;
}

async function selfTest() {
  const cases = [
    {
      name: 'positive-control',
      expectOk: true,
      responses: [
        assistantToolCall('self_compact', { note_to_self: NOTE }),
        SUMMARY,
        assistantToolCall('write', { path: 'result.txt', content: 'done' }),
        assistantText('Done.'),
      ],
    },
    {
      name: 'never-writes',
      expectOk: false,
      responses: [
        assistantToolCall('self_compact', { note_to_self: NOTE }),
        SUMMARY,
        assistantText('I will not write anything.'),
      ],
    },
    {
      name: 'writes-done-newline',
      expectOk: false,
      responses: [
        assistantToolCall('self_compact', { note_to_self: NOTE }),
        SUMMARY,
        assistantToolCall('write', { path: 'result.txt', content: 'done\n' }),
        assistantText('Done.'),
      ],
    },
    {
      name: 'rewrites-file',
      expectOk: false,
      responses: [
        assistantToolCall('self_compact', { note_to_self: NOTE }),
        SUMMARY,
        assistantToolCall('write', { path: 'result.txt', content: 'done' }),
        assistantToolCall('write', { path: 'result.txt', content: 'done' }),
        assistantText('Done.'),
      ],
    },
    {
      name: 'never-settles',
      expectOk: false,
      timeoutMs: 50,
      responses: [
        assistantToolCall('self_compact', { note_to_self: NOTE }),
        SUMMARY,
        assistantToolCall('write', { path: 'result.txt', content: 'done' }),
        assistantText('Done.'),
      ],
    },
  ];

  const results = [];
  let allGood = true;
  for (const c of cases) {
    const verdict = await runFauxScenario({
      responses: c.responses,
      ...(c.timeoutMs ? { timeoutMs: c.timeoutMs } : {}),
    });
    const pass = verdict.ok === c.expectOk;
    if (!pass) allGood = false;
    results.push({
      case: c.name,
      expectOk: c.expectOk,
      actualOk: verdict.ok,
      correct: pass,
      failures: verdict.failures,
    });
    const tag = pass ? 'ok' : 'WRONG';
    console.log(`  self-test[${c.name}] expectOk=${c.expectOk} actualOk=${verdict.ok} => ${tag}`);
  }
  return { ok: allGood, results };
}

// ---------------------------------------------------------------------------
// Live scenarios (real authenticated provider/model)
// ---------------------------------------------------------------------------

function parseVersion(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function versionAtLeast(actual, min) {
  const a = parseVersion(actual);
  const b = parseVersion(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

async function runtimeVersion() {
  const run = await spawnPi({ args: ['--version'], cwd: PKG, timeoutMs: 30000 });
  return (run.stdout + run.stderr).trim();
}

/** Claim ownership of result.txt, refusing to overwrite unowned user data. */
function claimResult() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  if (existsSync(RESULT_TXT)) {
    let owned = false;
    if (existsSync(OWNER_FILE)) {
      try {
        owned = JSON.parse(readFileSync(OWNER_FILE, 'utf8')).path === RESULT_TXT;
      } catch {
        owned = false;
      }
    }
    if (!owned) {
      throw new Error(`refusing to overwrite ${RESULT_TXT}: it predates this driver and ownership is unclear`);
    }
    rmSync(RESULT_TXT, { force: true });
  }
  writeFileSync(
    OWNER_FILE,
    `${JSON.stringify({ path: RESULT_TXT, nonce: Math.random().toString(36).slice(2), createdAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

async function runLive(provider, model) {
  rmSync(LIVE_SESSION_DIR, { recursive: true, force: true });
  mkdirSync(LIVE_SESSION_DIR, { recursive: true });
  // Scratch agent settings (not the user's global config): low keep/reserve so a
  // modest real conversation has something to summarize, without filling 200k+
  // tokens just to prepare one compaction. Auth still resolves from the ambient
  // provider credentials Pi manages.
  rmSync(LIVE_AGENT_DIR, { recursive: true, force: true });
  mkdirSync(LIVE_AGENT_DIR, { recursive: true });
  writeFileSync(
    join(LIVE_AGENT_DIR, 'settings.json'),
    JSON.stringify({ compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 16384 } }),
  );
  const liveEnv = { PI_CODING_AGENT_DIR: LIVE_AGENT_DIR };
  const scenarios = [];
  for (const variant of [
    { name: 'launch-defaults', flags: [], expected: [225000, 250000, 270000] },
    {
      name: 'launch-tokens',
      flags: ['--compact-soft-at', '100k', '--compact-at', '200k', '--compact-buffer', '50k'],
      expected: [100000, 200000, 250000],
    },
    {
      name: 'launch-percent-zero-buffer',
      flags: [
        '--compact-soft-at',
        '20%',
        '--compact-at',
        '50%',
        '--compact-buffer',
        '0',
        '--compact-prompt',
        'Summarize the current goal, completed work, exact paths, test results, and next action. Do not invent completed work.',
      ],
    },
  ]) {
    const run = await spawnPi({
      args: [
        '--mode',
        'rpc',
        '--provider',
        provider,
        '--model',
        model,
        '--no-session',
        '--no-context-files',
        '-ne',
        '-e',
        SELF_COMPACT_EXT,
        ...variant.flags,
      ],
      cwd: PKG,
      timeoutMs: 30000,
      env: liveEnv,
      input: JSON.stringify({ id: variant.name, type: 'prompt', message: '/self-compact-info' }) + '\n',
      stopAfterInfo: true,
    });
    const events = parseEvents(run.stdout);
    const info =
      events.find(
        (e) =>
          e.type === 'extension_ui_request' && e.method === 'notify' && e.message?.startsWith('self-compact info:'),
      )?.message ?? '';
    const window = Number(/model window: (\d+)/.exec(info)?.[1]);
    const expected = variant.expected ?? [Math.floor(window * 0.2), Math.floor(window * 0.5), Math.floor(window * 0.5)];
    const failures = [];
    if (run.timedOut || !run.requestedStop) failures.push('launch did not return observable info before shutdown');
    if (!Number.isFinite(window) || window < 300000)
      failures.push('launch requires an actual model window of at least 300000');
    for (const [index, label] of ['soft', 'warning', 'hard'].entries()) {
      if (!info.includes(`${label}=${expected[index]} (`)) failures.push(`incorrect ${label} resolution`);
    }
    if (events.some((e) => e.type === 'agent_start')) failures.push('info unexpectedly started an LLM turn');
    if (!variant.expected && !info.includes('--compact-prompt (literal)'))
      failures.push('literal summary override not selected');
    scenarios.push({ name: variant.name, ok: failures.length === 0, failures, evidence: { info, window } });
  }
  if (scenarios.some((s) => !s.ok)) return { scenarios };
  claimResult();

  // 1) Fresh continuation. cwd = package dir so the model's relative result.txt
  // write lands at the exact evidence path; only self-compact is loaded.
  const liveArgs = [
    '-p',
    '--mode',
    'json',
    '--provider',
    provider,
    '--model',
    model,
    '--session-dir',
    LIVE_SESSION_DIR,
    '--session-id',
    'self-compact-live',
    '--no-context-files',
    '-ne',
    '-e',
    SELF_COMPACT_EXT,
    ...LIVE_FLAGS,
    LIVE_TASK,
  ];
  const run = await spawnPi({ args: liveArgs, cwd: PKG, timeoutMs: 240000, env: liveEnv });
  const events = parseEvents(run.stdout);
  const ev = collectEvidence(events, { targetPath: RESULT_TXT, cwd: PKG });
  const fileBytes = readBytes(RESULT_TXT);
  const mtimeAfterWrite = mtimeOf(RESULT_TXT);
  const continuation = evaluateContinuation({ ev, timedOut: run.timedOut, exitCode: run.exitCode, fileBytes });

  scenarios.push({
    name: 'fresh-continuation',
    ok: continuation.ok,
    failures: continuation.failures,
    evidence: {
      note: ev.selfCompactNotes,
      agentStarts: ev.agentStarts,
      compactionEnds: ev.compactionEnds,
      resultWrites: ev.resultWrites,
      deliveredEntries: ev.deliveredEntries,
      finalPhase: ev.finalPhase,
      completedCycles: ev.latestCompletedCycles,
      fileBytes,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
    },
    ...(run.stderr.trim() ? { stderrTail: run.stderr.trim().split('\n').slice(-8).join('\n') } : {}),
  });

  // Only continue with reload scenarios if the continuation itself succeeded and
  // the file exists (otherwise there is nothing durable to reload).
  if (continuation.ok) {
    // 2) Bare reload: resume with NO prompt. No handoff replay, no provider
    // request, no rewrite.
    const bareArgs = [
      '-p',
      '--mode',
      'json',
      '--provider',
      provider,
      '--model',
      model,
      '--session-dir',
      LIVE_SESSION_DIR,
      '--session',
      'self-compact-live',
      '--continue',
      '--no-context-files',
      '-ne',
      '-e',
      SELF_COMPACT_EXT,
      ...LIVE_FLAGS,
    ];
    const bare = await spawnPi({ args: bareArgs, cwd: PKG, timeoutMs: 60000, env: liveEnv });
    const bareEv = collectEvidence(parseEvents(bare.stdout), { targetPath: RESULT_TXT, cwd: PKG });
    const bareBytes = readBytes(RESULT_TXT);
    const bareMtime = mtimeOf(RESULT_TXT);
    const bareFailures = [];
    if (bare.timedOut) bareFailures.push('bare reload timed out');
    if (bare.exitCode !== 0) bareFailures.push(`bare reload exited ${bare.exitCode}`);
    if (!bareEv.sawSessionEvent) bareFailures.push('bare reload did not load a session');
    if (bareEv.agentStarts !== 0)
      bareFailures.push(`bare reload started ${bareEv.agentStarts} turn(s) (expected 0 provider requests)`);
    if (bareEv.compactionEnds.length !== 0) bareFailures.push('bare reload replayed a compaction');
    if (bareEv.deliveredEntries !== 0) bareFailures.push('bare reload re-delivered a handoff');
    if (bareEv.resultWrites.length !== 0) bareFailures.push('bare reload rewrote result.txt');
    if (bareBytes !== EXPECTED_BYTES) bareFailures.push('result.txt changed across bare reload');
    if (bareMtime !== mtimeAfterWrite) bareFailures.push('result.txt mtime changed across bare reload');
    scenarios.push({
      name: 'reload-no-replay',
      ok: bareFailures.length === 0,
      failures: bareFailures,
      evidence: { agentStarts: bareEv.agentStarts, sawSessionEvent: bareEv.sawSessionEvent, exitCode: bare.exitCode },
    });

    // 3) A second, completed-task handoff: its autonomous continuation must
    // honor the completed note rather than rewriting the result.
    const probeArgs = [
      '-p',
      '--mode',
      'json',
      '--provider',
      provider,
      '--model',
      model,
      '--session-dir',
      LIVE_SESSION_DIR,
      '--session',
      'self-compact-live',
      '--continue',
      '--no-context-files',
      '-ne',
      '-e',
      SELF_COMPACT_EXT,
      ...LIVE_FLAGS,
      COMPLETED_TASK_PROBE,
    ];
    const probe = await spawnPi({ args: probeArgs, cwd: PKG, timeoutMs: 120000, env: liveEnv });
    const probeEv = collectEvidence(parseEvents(probe.stdout), { targetPath: RESULT_TXT, cwd: PKG });
    const probeBytes = readBytes(RESULT_TXT);
    const probeMtime = mtimeOf(RESULT_TXT);
    const probeFailures = [];
    if (probe.timedOut) probeFailures.push('completed-task probe timed out');
    if (probe.exitCode !== 0) probeFailures.push(`completed-task probe exited ${probe.exitCode}`);
    if (probeEv.selfCompactNotes.length !== 1 || probeEv.selfCompactNotes[0] !== COMPLETED_NOTE)
      probeFailures.push('completed-task probe did not checkpoint the exact completed note once');
    if (
      probeEv.compactionEnds.length !== 1 ||
      !probeEv.compactionEnds[0]?.hasSummary ||
      probeEv.compactionEnds[0]?.aborted
    )
      probeFailures.push('completed-task handoff did not compact successfully once');
    if (probeEv.deliveredEntries !== 1 || probeEv.latestCompletedCycles !== 2 || probeEv.agentStarts < 2)
      probeFailures.push('completed-task note did not autonomously continue as the second cycle');
    if (!probeEv.continuationNotes.some((note) => note.includes(COMPLETED_NOTE)))
      probeFailures.push('completed-task note was not returned verbatim');
    if (probeEv.resultWrites.length !== 0)
      probeFailures.push('completed-task probe rewrote result.txt (repeated completed work)');
    if (probeBytes !== EXPECTED_BYTES) probeFailures.push('result.txt content changed during completed-task probe');
    if (probeMtime !== mtimeAfterWrite) probeFailures.push('result.txt mtime changed during completed-task probe');
    scenarios.push({
      name: 'completed-task-note',
      ok: probeFailures.length === 0,
      failures: probeFailures,
      evidence: {
        agentStarts: probeEv.agentStarts,
        resultWrites: probeEv.resultWrites.length,
        exitCode: probe.exitCode,
      },
    });
  }

  return { scenarios };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const selfTestOnly = argv.includes('--self-test');
  const liveOnly = argv.includes('--live-only');
  const startedAt = new Date().toISOString();

  const report = { tool: 'self-compact live driver', startedAt, minRuntime: MIN_VERSION };
  let ok = true;

  if (!liveOnly) {
    console.log('Running deterministic self-test (offline; wrong behavior must fail)...');
    const st = await selfTest();
    report.selfTest = st.results;
    if (!st.ok) {
      ok = false;
      console.error('FAIL: driver self-test did not reject wrong behavior; aborting before any live spend.');
    }
  }

  if (selfTestOnly || !ok) {
    finish(report, ok, startedAt);
    return;
  }

  // Runtime version gate.
  const version = await runtimeVersion();
  report.runtimeVersion = version;
  if (!versionAtLeast(version, MIN_VERSION)) {
    report.versionError = `runtime ${version} is below required ${MIN_VERSION}`;
    console.error(`FAIL: ${report.versionError}`);
    finish(report, false, startedAt);
    return;
  }

  // Provider/model resolution (fail closed on missing credentials/selection).
  const provider = process.env.SELF_COMPACT_LIVE_PROVIDER || process.env.PI_PROVIDER;
  const model = process.env.SELF_COMPACT_LIVE_MODEL || process.env.PI_MODEL;
  report.provider = provider ?? null;
  report.model = model ?? null;
  if (!provider || !model) {
    report.credentialError =
      'no provider/model selected (set PI_PROVIDER/PI_MODEL or SELF_COMPACT_LIVE_PROVIDER/MODEL)';
    console.error(`FAIL: ${report.credentialError}`);
    finish(report, false, startedAt);
    return;
  }

  console.log(`Running live acceptance with ${provider}/${model}...`);
  try {
    const live = await runLive(provider, model);
    report.scenarios = live.scenarios;
    for (const s of live.scenarios) {
      const tag = s.ok ? 'PASS' : 'FAIL';
      console.log(`  live[${s.name}] => ${tag}`);
      if (!s.ok) {
        ok = false;
        for (const f of s.failures) console.error(`    - ${f}`);
      }
    }
    if (live.scenarios.length < 6) {
      ok = false;
      report.skippedScenarios = 'reload scenarios did not run because the fresh continuation failed';
      console.error('FAIL: required reload scenarios were skipped (a skipped required scenario is a failure)');
    }
  } catch (error) {
    ok = false;
    report.error = error instanceof Error ? error.message : String(error);
    console.error(`FAIL: ${report.error}`);
  }

  finish(report, ok, startedAt);
}

function finish(report, ok, startedAt) {
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - Date.parse(startedAt);
  report.overall = ok ? 'PASS' : 'FAIL';
  try {
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Report written to ${REPORT_FILE}`);
  } catch (error) {
    ok = false;
    report.overall = 'FAIL';
    console.error(`could not write report: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(`Overall: ${report.overall}`);
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
