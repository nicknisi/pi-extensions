// autoplan.js — pick the best practical solution and write its implementation plan.
//
// Ported from osolmaz/pi-workflows' autoplan. Theirs is a durable graph with
// human decision gates; this is the same reasoning shape as a flat script:
// candidates fan out in parallel, a judge picks one WITHOUT asking the user
// to choose, and a checkpoint gates the expensive plan write.
//
// THE REASONING SHAPE (the part worth stealing):
//   1. 2-4 distinct practical candidates IN PARALLEL, each answering: gist,
//      full solution, rationale, parts, trade-offs, and "is this the
//      long-term-elegant production-ready answer?"
//   2. The Holy Grail described SEPARATELY — the unconstrained ideal — with
//      every dependency outside our authority named.
//   3. A judge picks WITHOUT punting to the user: choose the Holy Grail when
//      it is proportionate and implementable through interfaces we control;
//      otherwise the strongest practical option with a clear path toward it.
//      One rejection reason per losing candidate. Never block just because
//      the Grail needs an upstream change.
//   4. checkpoint() gates the plan write — eyeball the choice before spending
//      tokens on the full plan.
//   5. Plan writer: per step, what changes, where, and how to verify.
//
// HOW TO ADAPT: pass { problem, scope, constraints } via args —
//   /wf run autoplan {"problem":"choose a timeout fallback","scope":"packages/workflows only","constraints":["keep cancellation terminal"]}

export const meta = {
  name: 'autoplan',
  description: 'Parallel candidates, judge picks without punting to the user, checkpoint-gated plan write',
};

const PROBLEM = (args && args.problem) || 'State the decision or planning problem and its observable end state.';
const SCOPE = (args && args.scope) || 'This repository. Name important exclusions.';
const CONSTRAINTS = (args && args.constraints) || [];

const CONTEXT = `PROBLEM: ${PROBLEM}\nSCOPE: ${SCOPE}\nCONSTRAINTS: ${JSON.stringify(CONSTRAINTS)}`;

phase('candidates');
const CANDIDATE_IDS = ['A', 'B', 'C'];
const candidates = await parallel(
  CANDIDATE_IDS.map((id) => async () => {
    return agent(
      `${CONTEXT}\n\nYou are candidate advocate ${id}. Propose a DISTINCT practical solution ` +
        `(different from what other advocates would pick). Give: short title, plain gist, full ` +
        `solution, rationale, parts, trade-offs, and a yes/no on "is this the long-term-elegant ` +
        `production-ready answer". Ground every claim in the actual codebase.`,
      { label: `candidate-${id}` },
    );
  }),
);

phase('holy grail');
const grail = await agent(
  `${CONTEXT}\n\nDescribe the Holy Grail: the ideal solution with no practical constraints. ` +
    `Name every dependency outside our authority (upstream changes, other teams, new services).`,
  { label: 'grail' },
);

phase('judge');
const verdict = await agent(
  `${CONTEXT}\n\nCANDIDATES:\n${candidates.map((c, i) => `--- Candidate ${CANDIDATE_IDS[i]} ---\n${c}`).join('\n\n')}\n\n` +
    `HOLY GRAIL:\n${grail}\n\nPick the right option WITHOUT asking the user to decide. Choose the Holy Grail ` +
    `when it is proportionate, production-ready, in scope, and implementable through interfaces we control. ` +
    `Otherwise choose the strongest practical in-scope candidate with a clear path toward the Grail. ` +
    `Record one rejection reason for every other candidate.`,
  {
    label: 'judge',
    schema: {
      type: 'object',
      properties: {
        choice: { type: 'string' },
        isGrail: { type: 'boolean' },
        gist: { type: 'string' },
        rejections: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } } },
        },
      },
      required: ['choice', 'gist', 'rejections'],
    },
  },
);

log(`judge picked: ${verdict.choice} (${verdict.gist})`);
await checkpoint(`plan "${verdict.choice}"`);

phase('plan');
const plan = await agent(
  `${CONTEXT}\n\nWrite the implementation plan for the selected option:\n${verdict.gist}\n\n` +
    `For each step state WHAT changes, WHERE (exact files), and HOW TO VERIFY it. ` +
    `End with a "rejected alternatives" section: ${JSON.stringify(verdict.rejections)}`,
  { label: 'planner' },
);

return { choice: verdict.choice, gist: verdict.gist, rejections: verdict.rejections, plan };
