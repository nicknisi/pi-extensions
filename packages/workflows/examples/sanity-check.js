// sanity-check.js — read-only review of a contribution: necessary? duplicated? proportionate?
//
// Ported from osolmaz/pi-workflows' sanity-check. Four area reviewers run in
// parallel, then a verifier REFUTES the findings — every concern must survive
// a skeptic with exact file:symbol evidence or it's dropped. The verdict is
// strict: keep | simplify | refactor | drop | needs-evidence.
//
// THE REASONING SHAPE (the part worth stealing):
//   1. Evidence first: one agent collects the diff (base..HEAD + working tree
//      + untracked) so reviewers judge facts, not the PR description.
//   2. Four reviewers in PARALLEL, one area each: necessity (is this needed
//      at all?), duplication (does the codebase already do this?), contracts
//      (are new abstractions justified?), scope+tests (proportionate?).
//   3. A verifier that tries to REFUTE every concern. Confirmation bias is
//      the default failure mode of review; a skeptic pass is the fix.
//   4. Read-only: reviewers get read tools only; nothing edits, posts, or fixes.
//
// HOW TO ADAPT: pass { baseRef } via args — /wf run sanity-check {"baseRef":"origin/main"}

export const meta = {
  name: 'sanity-check',
  description: 'Parallel necessity/duplication/contracts/scope review, then a verifier that refutes every finding',
};

const BASE = (args && args.baseRef) || 'origin/main';

phase('evidence');
const evidence = await agent(
  `Collect the contribution under review in this repo: \`git diff ${BASE}...HEAD\`, the working-tree ` +
    `diff (\`git diff\`), untracked files (\`git status --porcelain\`), and the matching PR title/body ` +
    `(\`gh pr view\`) if one exists. Return the full raw evidence. Do not editorialize.`,
  { label: 'evidence', tools: ['read', 'bash', 'grep', 'find'] },
);

phase('reviewers');
const AREAS = [
  [
    'necessity',
    'Is this contribution NECESSARY? What breaks or stays broken without it? Could the need be met without new code?',
  ],
  [
    'duplication',
    'Does the codebase already have this? Search for existing helpers, patterns, and near-misses that cover the same ground.',
  ],
  [
    'contracts',
    'Are new abstractions (interfaces, config, public API surface) justified by more than one caller? Flag speculative generality.',
  ],
  [
    'scope-tests',
    'Is the scope proportionate to the problem? Are tests present, focused, and actually exercising the change?',
  ],
];
const findings = await parallel(
  AREAS.map(([area, brief]) => async () => {
    return agent(
      `You are the ${area} reviewer. ${brief}\n\nReport pass | concern | unclear per point, with EXACT ` +
        `file:symbol evidence for every claim. No evidence = do not claim it.\n\nEVIDENCE:\n${evidence}`,
      { label: `review-${area}` },
    );
  }),
);

phase('verify');
const verdict = await agent(
  `You are a hostile verifier. Below are four reviewers' findings about a contribution. Try to REFUTE ` +
    `every concern: check the cited file:symbol yourself and drop anything unsupported or wrong. Then ` +
    `issue one verdict: keep | simplify | refactor | drop | needs-evidence.\n\n` +
    `FINDINGS:\n${findings.map((f, i) => `--- ${AREAS[i][0]} ---\n${f}`).join('\n\n')}`,
  {
    label: 'verifier',
    schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['keep', 'simplify', 'refactor', 'drop', 'needs-evidence'] },
        survivingConcerns: { type: 'array', items: { type: 'string' } },
        refutedClaims: { type: 'array', items: { type: 'string' } },
        rationale: { type: 'string' },
      },
      required: ['verdict', 'survivingConcerns', 'rationale'],
    },
  },
);

return verdict;
