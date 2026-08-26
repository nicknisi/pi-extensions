// autoimplement.js — implement a plan end-to-end with a bounded review/fix loop.
//
// Ported from osolmaz/pi-workflows' autoimplement, cut to the loop that
// matters: gate the plan with a human (their approval modes become one ask),
// build, verify, review, fix, repeat until a reviewer finds no P0/P1 or the
// round cap trips. Theirs adds PR/CI watching and pi-reviewer integration —
// add that back as a stage when you need it (YAGNI until then).
//
// THE REASONING SHAPE (the part worth stealing):
//   1. NEVER devise a new plan — the plan is input. If evidence invalidates
//      it mid-run, stop and say so (re-plan is autoplan's job).
//   2. ask() gates the plan BEFORE tokens burn: approve / edit / abort.
//   3. Review loop is BOUNDED (MAX_ROUNDS) — an unbounded fix loop is a
//      wallet drain with extra steps. P0/P1 block; P2 noted but non-blocking.
//   4. Verification runs after EVERY fix round, not just the first build.
//
// HOW TO ADAPT: pass { task, plan, verify } via args —
//   /wf run autoimplement {"task":"add timeout fallback","plan":"...","verify":"pnpm typecheck"}

export const meta = {
  name: 'autoimplement',
  description: 'Human-gated plan → build → verify → review/fix loop, bounded rounds, P0/P1 block',
};

const TASK = (args && args.task) || 'Implement the plan.';
const PLAN = (args && args.plan) || '(no plan supplied — stop and ask for one)';
const VERIFY = (args && args.verify) || 'npx tsgo --noEmit';
const MAX_ROUNDS = 3;
const BUILDER_TOOLS = ['read', 'edit', 'write', 'bash', 'grep', 'find'];

if (!args || !args.plan) throw new Error('autoimplement requires args.plan — never devise a new plan here.');

const decision = await ask(`Implement this plan?\n\nTask: ${TASK}\n\nPlan:\n${PLAN.slice(0, 2000)}`, [
  'implement',
  'abort',
]);
if (decision !== 'implement') throw new Error(`aborted at plan gate (${decision ?? 'dismissed'})`);

phase('build');
let build = await agent(
  `Implement this plan end-to-end, minimal and correct. Run \`${VERIFY}\` and make it pass before ` +
    `finishing. Report: files changed, one line per change, verify output tail.\n\nTASK: ${TASK}\n\nPLAN:\n${PLAN}`,
  { label: 'builder', tools: BUILDER_TOOLS },
);

for (let round = 1; round <= MAX_ROUNDS; round++) {
  phase(`review round ${round}`);
  const review = await agent(
    `Review the implementation against the plan. Classify every finding P0 (wrong/unsafe), P1 (should ` +
      `fix before merge), P2 (proportionate improvements). Verify claims against the actual files — no ` +
      `evidence, no finding. Ignore legacy-compatibility asks unless the plan requires them.\n\n` +
      `PLAN:\n${PLAN}\n\nBUILDER REPORT:\n${build}`,
    {
      label: 'reviewer',
      schema: {
        type: 'object',
        properties: {
          p0: { type: 'array', items: { type: 'string' } },
          p1: { type: 'array', items: { type: 'string' } },
          p2: { type: 'array', items: { type: 'string' } },
        },
        required: ['p0', 'p1', 'p2'],
      },
    },
  );

  if (review.p0.length === 0 && review.p1.length === 0) {
    return { status: 'clean', rounds: round, p2: review.p2, build };
  }
  if (round === MAX_ROUNDS) {
    return { status: 'round-cap', blocking: [...review.p0, ...review.p1], build };
  }

  phase(`fix round ${round}`);
  build = await agent(
    `Fix these review findings, then re-run \`${VERIFY}\` and make it pass. Report files changed.\n\n` +
      `P0/P1 FINDINGS:\n${[...review.p0, ...review.p1].map((f) => `- ${f}`).join('\n')}`,
    { label: 'fixer', tools: BUILDER_TOOLS },
  );
}
