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
//   3. An advisor ranks the options with a recommendation, curbing Grail
//      ideas that need upstream changes we don't control.
//   4. THE DECISION GATE IS THE HUMAN: ask() lists the options with the
//      recommendation on top. The whole point of the workflow is that you
//      only decide AFTER it finishes mining — including rejecting everything.
//   5. Plan writer elaborates the CHOSEN option: per step, what changes,
//      where, and how to verify.
//
// HOW TO ADAPT: pass { problem, scope, constraints } via args —
//   /wf run autoplan {"problem":"choose a timeout fallback","scope":"packages/workflows only","constraints":["keep cancellation terminal"]}
// Or just say "autoplan this" — the bundled skill derives the args from the
// conversation.

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

phase('advisor');
// The advisor RECOMMENDS but does not decide — the human is the gate. It
// curbs Holy Grail ideas that need changes outside our authority.
const advice = await agent(
  `${CONTEXT}\n\nCANDIDATES:\n${candidates.map((c, i) => `--- Candidate ${CANDIDATE_IDS[i]} ---\n${c}`).join('\n\n')}\n\n` +
    `HOLY GRAIL:\n${grail}\n\nRank the options for practicality and simplicity, preferring interfaces we ` +
    `control; reject any Grail that needs an upstream change as UNIMPLEMENTABLE NOW (note it, don't pick it). ` +
    `Return a short title + one-line gist per option (candidates AND the grail if it qualifies), the ` +
    `recommended id, why, and one rejection reason per loser.`,
  {
    label: 'advisor',
    schema: {
      type: 'object',
      properties: {
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, title: { type: 'string' }, gist: { type: 'string' } },
            required: ['id', 'title', 'gist'],
          },
        },
        recommended: { type: 'string' },
        why: { type: 'string' },
        rejections: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } } },
        },
      },
      required: ['options', 'recommended', 'why', 'rejections'],
    },
  },
);

phase('decision gate');
// The human decides — after the mining, not during. Recommendation first.
const ordered = [...advice.options].sort((a, b) =>
  a.id === advice.recommended ? -1 : b.id === advice.recommended ? 1 : 0,
);
const REJECT = 'none — reject all / re-mine';
const choice = await ask(`Recommended: ${advice.recommended} — ${advice.why}\n\nPick a direction:`, [
  ...ordered.map((o) => `${o.id}: ${o.title} — ${o.gist}`),
  REJECT,
]);
const picked = choice && choice !== REJECT ? ordered.find((o) => choice.startsWith(`${o.id}:`)) : undefined;
if (!picked) {
  // Dismissed, reject-all, or off-list custom text — never silently decide
  // for the human; hand the outcome (and any custom answer) back to re-mine.
  return {
    decided: false,
    ...(choice && choice !== REJECT ? { custom: choice } : {}),
    options: advice.options,
    recommended: advice.recommended,
    why: advice.why,
    rejections: advice.rejections,
  };
}
log(`human picked: ${picked.id} ${picked.title}`);

phase('plan');
const plan = await agent(
  `${CONTEXT}\n\nWrite the implementation plan for the SELECTED option (${picked.id}): ${picked.title} — ${picked.gist}\n\n` +
    `For each step state WHAT changes, WHERE (exact files), and HOW TO VERIFY it. ` +
    `End with a "rejected alternatives" section: ${JSON.stringify(advice.rejections)}`,
  { label: 'planner' },
);

return { decided: true, choice: picked, why: advice.why, rejections: advice.rejections, plan };
