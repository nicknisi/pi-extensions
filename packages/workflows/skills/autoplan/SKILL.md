---
name: autoplan
description: Use when the user says "autoplan this", "autoplan", or wants an open-ended design/bugfix problem mined into a multiple-choice decision. Runs the saved autoplan workflow — parallel candidates, holy-grail check, advisor recommendation, human decision gate, plan write.
---

# Autoplan

Mine the agent for ideas mechanically instead of debating design in the open: the `autoplan`
workflow fans out candidate solutions, checks the holy grail, ranks them with a recommendation,
and stops at a human decision gate. The user decides AFTER the mining, never during.

## Run it

Call the `workflow` tool: action `run`, name `autoplan`, with `args` derived from the current
conversation. Do not ask the user to restate what "this" means — derive it:

- `problem`: the decision or planning problem and its observable end state.
- `scope`: repos, systems, and interfaces that may change, plus important exclusions.
- `constraints`: array of user/repo/safety/authority limits; `[]` when none apply.

If `workflow` `list` shows no `autoplan`, install it first: copy `examples/autoplan.js` from the
`@nicknisi/pi-workflows` package into `~/.pi/agent/workflows/autoplan.js`, then run.

## After the run

- `decided: false` — the user rejected every option or dismissed the gate. Present the options and
  the advisor's recommendation; offer to re-mine with new constraints or a proposed new option.
  Never write a plan for an undecided run.
- `decided: true` — present `choice` and the `plan`. Elaborate sections on request.
