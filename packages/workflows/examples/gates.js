// gates.js — judge/verify PROMPT builders.
//
// WHAT IT'S FOR: the prompt engineering that turns a flaky judge into a
// reliable gate. Each builder is a function returning a prompt STRING; copy
// the one that matches your gate into your own workflow and hand it to an
// agent() with a JSON schema. These are PATTERNS, not an API — read them,
// adapt the framing to your task, do not import this file.
//
// The valuable knowledge here is WHAT failure mode each framing prevents:
//   adversarialReview      → confirmation bias / sycophancy
//   deepResearchCoverage   → silent source omission / single-source skew
//   codeReviewVerdict      → verdict collapse + severity ordering
//
// Prompt patterns distilled from @quintinshaw/pi-dynamic-workflows (MIT).
// Substantial portions of the prompt text below are adapted from that
// package, whose LICENSE requires this notice:
//
//   Copyright (c) 2026 QuintinShaw
//   Copyright (c) Michael Livs (original pi-dynamic-workflows)
//
//   Permission is hereby granted, free of charge, to any person obtaining a
//   copy of this software and associated documentation files (the
//   "Software"), to deal in the Software without restriction, including
//   without limitation the rights to use, copy, modify, merge, publish,
//   distribute, sublicense, and/or sell copies of the Software, and to
//   permit persons to whom the Software is furnished to do so, subject to
//   the following conditions: the above copyright notice and this
//   permission notice shall be included in all copies or substantial
//   portions of the Software.

export const meta = {
  name: 'gates',
  description: 'Judge/verify prompt builders: adversarial refutation, research coverage, code-review verdict',
};

// ── Adversarial refutation ─────────────────────────────────────────────────
// Prevents: confirmation bias. A reviewer asked "is this finding real?" tends
// to agree (sycophancy), and a wrong finding survives. Reframing the job as
// "try to REFUTE this; default to real=false when uncertain" flips the prior:
// a finding survives only when enough independent skeptics FAIL to refute it.
// `reviewers` skeptics vote in parallel; the finding survives when the
// real-vote share meets `threshold`. The "state the strongest reason it could
// be WRONG first" line forces the skeptic to actually attack, not rubber-stamp.
const adversarialReview = (task, finding, reviewers, threshold) =>
  'You are a skeptical reviewer. Try to REFUTE this finding for the task below. ' +
  'Default to real=false when uncertain; investigate with the available tools if needed. ' +
  'State the strongest reason the finding could be WRONG before you decide.\n\n' +
  'TASK: ' +
  task +
  '\nFINDING: ' +
  finding +
  '\n\nReturn JSON { real: boolean, reason: string }. This finding is counted real only ' +
  'if it survives ' +
  reviewers +
  ' independent refuters at threshold ' +
  threshold +
  '.';

// ── Deep-research coverage check ──────────────────────────────────────────
// Prevents: silent source omission. A research fan-out gathers N sources and
// lists claims; without a coverage check, a claim from a single weak source
// (or one a model half-remembered and attributed to a plausible URL) survives
// alongside well-sourced ones. This gate groups claims asserting the SAME
// fact across DISTINCT source URLs and keeps a claim only when it has
// `minSupport` distinct sources OR one clearly authoritative source. Conflicts
// and single-source claims are discarded — the report says so explicitly.
const deepResearchCoverage = (sources, minSupport) =>
  'Cross-check these research sources. Group claims that assert the same fact across ' +
  'different source URLs. Keep a claim only if it is supported by at least ' +
  minSupport +
  ' distinct source URLs OR by one clearly authoritative source. Discard claims found in ' +
  'a single weak source or that conflict with others. Do not invent sources.\n\n' +
  'SOURCES JSON:\n' +
  JSON.stringify(sources) +
  '\n\nReturn JSON { supported: [{ claim, sources: [url] }], discarded: [claim] }.';

// ── Code-review verdict + severity ─────────────────────────────────────────
// Prevents: verdict collapse. A boolean "is this issue real?" collapses
// CONFIRMED (will break) and PLAUSIBLE (worth a look) into one bucket, losing
// the hedge the report needs. A 3-way verdict — CONFIRMED / PLAUSIBLE /
// REFUTED — with a per-finding failure scenario keeps the signal; only REFUTED
// is filtered out. Severity framing: name the concrete failure scenario, not a
// vague "this might be bad" — a finding with no traceable failure is PLAUSIBLE
// at best, never CONFIRMED.
const codeReviewVerdict = (finding, diffBlock) =>
  'You are a verifier. Determine whether this code review finding is CONFIRMED, PLAUSIBLE, ' +
  'or REFUTED.\n' +
  'CONFIRMED = you can trace the exact failure in the diff.\n' +
  'PLAUSIBLE = the concern is valid but not certain.\n' +
  'REFUTED = the finding is wrong or already handled.\n\n' +
  'FINDING:\n' +
  finding +
  diffBlock +
  '\n\nReturn JSON { verdict: "CONFIRMED"|"PLAUSIBLE"|"REFUTED", reason: string }. ' +
  'If you cannot trace a concrete failure scenario, return at most PLAUSIBLE.';

// Demonstrate the shapes — copy whichever builder fits your gate.
phase('gates');
log('adversarialReview  →', adversarialReview('ship the release', 'auth refresh leaks', 3, 0.66).slice(0, 60) + '…');
log('deepResearchCoverage →', deepResearchCoverage([{ url: 'https://example', claims: ['x'] }], 2).slice(0, 60) + '…');
log('codeReviewVerdict  →', codeReviewVerdict('file.ts:42 null deref', '\n<diff>…</diff>').slice(0, 60) + '…');

return {
  builders: ['adversarialReview', 'deepResearchCoverage', 'codeReviewVerdict'],
  note: 'Copy the builder that matches your gate; call it from agent() with a JSON schema.',
};
