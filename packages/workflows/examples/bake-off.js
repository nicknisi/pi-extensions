// bake-off.js — Bake-Off mode: race N models on one task, an advisory judge picks.
//
// WHEN BAKE-OFF BEATS A SINGLE BUILDER: empirically, a single GLM-5.2-class
// builder produces decent-but-flawed code — right shape, subtle bugs. Racing
// two models on the SAME task in ISOLATED worktrees and letting an advisory
// judge pick the winner is a quality lever: the judge sees two independent
// attempts AND their patches, and the better one wins. It costs ~2x the
// tokens of a single build for a measurably better hit rate on hard tasks.
// Don't run it for trivial edits — the judge overhead isn't worth it there.
//
// HOW IT WORKS:
//   1. Each contender runs as a builder agent with `worktree: true` — it
//      writes into its own detached worktree, so contenders never stomp each
//      other. On settle the subagent runtime captures the full change set
//      (including untracked files) to a `.patch`.
//   2. agent() returns `{ value, patchPath, runId }` for a worktree run that
//      changed files — the wrapper is opt-in: non-worktree agent() calls keep
//      returning the bare value, so existing scripts are unaffected.
//   3. A single judge agent receives all contender summaries + their patch
//      paths and returns `{ winner, why, confidence }`.
//   4. The workflow returns the winner's patchPath — apply it via the
//      subagents fleet apply flow (the `/patches` staging area: pre-flights
//      each patch without applying, then `Enter` to `git apply --3way`).
//
// Adapt: set CONTENDERS to the models you want to race, pass `task` in args
// (or edit DEFAULT_TASK). The judge can be a stronger/different model than the
// builders — set JUDGE_MODEL.

export const meta = {
  name: 'bake_off',
  description: 'Race N models on one task in isolated worktrees; an advisory judge picks the winner',
};

// Models to race, in 'provider/id' form. Add or remove contenders freely.
const CONTENDERS = ['z-ai/glm-5.2', 'anthropic/claude-sonnet-4-5'];
const JUDGE_MODEL = 'anthropic/claude-opus-4-1';

const DEFAULT_TASK = 'Implement X in packages/foo/bar.ts such that Y holds. Keep the change minimal and correct.';
const TASK = (args && args.task) || DEFAULT_TASK;

const BUILDER_TOOLS = ['read', 'edit', 'write', 'bash', 'grep', 'find'];
const BUILDER_PROMPT =
  'You are a builder. Implement the following task in this repo. Make the change minimal ' +
  'and correct; run the repo typecheck before finishing. Report a one-paragraph summary of ' +
  'what you changed and why.\n\nTASK:\n' +
  TASK;

// A throw inside parallel() collapses the wave — wrap each contender so a
// failure reports which model died instead of nuking the whole race.
const safeRun = (model, i) => async () => {
  try {
    const r = await agent(BUILDER_PROMPT, {
      label: 'contender-' + (i + 1),
      model,
      tools: BUILDER_TOOLS,
      worktree: true,
    });
    if (r && typeof r === 'object' && 'patchPath' in r) {
      return { model, ok: true, summary: r.value, patchPath: r.patchPath, runId: r.runId };
    }
    return { model, ok: true, summary: r, patchPath: null, runId: null };
  } catch (e) {
    return { model, ok: false, summary: 'contender crashed: ' + (e && e.message), patchPath: null, runId: null };
  }
};

phase('race');
const entries = await parallel(CONTENDERS.map(safeRun));

phase('judge');
const verdict = await agent(
  'You are an advisory judge for a model bake-off. Two builders each attempted the SAME ' +
    'task below, independently, in isolated worktrees. You are given each contender model, ' +
    'its self-reported summary, and the path to its patch. Read each patch (use bash: ' +
    '`cat <patchPath>`) and compare them on correctness, minimalism, and style. Pick the ' +
    'winner. Do not just trust the summaries — read the actual diffs (the read tool takes a path; no bash needed).\n\n' +
    'TASK:\n' +
    TASK +
    '\n\nCONTENDERS JSON:\n' +
    JSON.stringify(entries, null, 2) +
    '\n\nReturn JSON { winner: <model id>, why: <one paragraph>, confidence: "low"|"medium"|"high" }.',
  {
    label: 'judge',
    model: JUDGE_MODEL,
    tools: ['read'], // patches are files — read-only judging, no bash
    schema: {
      type: 'object',
      properties: {
        winner: { type: 'string' },
        why: { type: 'string' },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
      required: ['winner', 'why', 'confidence'],
    },
  },
);

const winner = entries.find((e) => e.model === verdict.winner) ?? entries[0];

return {
  winner: verdict.winner,
  why: verdict.why,
  confidence: verdict.confidence,
  // Apply this via the subagents /patches staging area (git apply --3way).
  patchPath: (winner && winner.patchPath) || null,
  contenders: entries.map((e) => ({ model: e.model, ok: e.ok, patchPath: e.patchPath })),
};
