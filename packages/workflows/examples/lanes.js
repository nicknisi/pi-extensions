// lanes.js — N parallel agents editing FILE-DISJOINT lanes of one repo.
//
// WHAT IT'S FOR: when a task splits into independent, file-disjoint edits
// across a single repo, lanes runs them concurrently under hard rules that
// make the parallelism safe: each lane owns a fixed file set, no lane touches
// git or installs, and the parent integrates centrally. This is the pattern
// behind "hardening lanes" — a blocker list split by subsystem, each lane
// owned by one agent.
//
// HOW TO ADAPT:
//   1. Set VERIFY to the repo's typecheck/lint command (repo-wide is fine —
//      errors in files a lane does NOT own are other lanes mid-edit; each
//      lane ignores them; only its own files must be clean).
//   2. Fill LANES with one entry per parallel edit: a `name`, the exact
//      `files` that lane may touch (no others), and a one-paragraph `brief`.
//   3. Run it: /wf run lanes
//   4. You (the parent) integrate the lanes' edits centrally — review and
//      stage them here.
//
// The hard-rules preamble is the pattern's soul — keep it. The fan-out is a
// single parallel() over the lanes. Cap lanes at the subagent runtime's child
// budget (4 by default); split into a second wave if you need more.

export const meta = {
  name: 'lanes',
  description: 'Parallel file-disjoint editing lanes under a hard-rules preamble',
};

// Repo-wide verification command. Replace with your project's typecheck
// (`npx tsgo --noEmit`, `tsc --noEmit`, `cargo check`, …).
const VERIFY = 'npx tsgo --noEmit';

const COMMON = `You are one of N parallel agents editing the same repo (cwd is the repo root).
HARD RULES — read before anything else:
1. Edit ONLY the files listed for your lane. Other agents own the rest concurrently; touching their files corrupts their work.
2. NO git commands, NO installs, NO format/test runners. The parent integrates centrally.
3. Verify ONLY with \`${VERIFY}\` run from the repo root. It is repo-wide, so errors in files you do NOT own are other lanes mid-edit — ignore those. YOUR files must be clean.
4. Match the existing code style.
5. No behavior changes beyond your lane's brief.
Report: files changed + one line per change.`;

// One entry per parallel edit. `files` is the lane's exclusive write set.
const LANES = [
  {
    name: 'engine',
    files: ['packages/shared/subagents.ts', 'packages/shared/workflow.ts'],
    brief: 'Make the budget counter event handling typecheck-visible…',
  },
  {
    name: 'dispatch',
    files: ['packages/subagents/index.ts'],
    brief: 'Add allowTreeMutation + serialize tree-mutating tasks…',
  },
  // Add lanes here (≤ ~4 per wave).
];

const lanes = LANES.map((l) => ({
  label: l.name,
  prompt: COMMON + '\n\nLANE ' + l.name + ' — ' + l.files.join(', ') + ' (no other files):\n\n' + l.brief,
}));

phase('lanes');
const results = await parallel(
  lanes.map((l) => () => agent(l.prompt, { label: l.label, tools: ['read', 'edit', 'write', 'bash', 'grep'] })),
);

return LANES.reduce((acc, l, i) => {
  acc[l.name] = results[i] ?? 'LANE RETURNED NULL (missing coverage)';
  return acc;
}, {});
