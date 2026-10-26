# @nicknisi/pi-subagents

First-party subagent dispatch and fleet for pi — fan out parallel child agents and inspect their runs, with **no dependency on pi-subagents**. Children are hermetic in-process agent sessions spawned through `@nicknisi/pi-shared`'s runtime (`createAgentSession` under the hood): fast to start, version-matched to the running pi, and unable to spawn children of their own.

## What it adds

- **`dispatch` tool** (model-facing) — fan out up to 8 child agents in parallel. Each task gets its own prompt, optional label/model/system-prompt, and a tool allowlist (default read-only: `read`, `grep`, `find`, `ls`). Running rows show cumulative token usage after each completed model response. Typed per-task results aggregate into one tool result. `background: true` runs detached and surfaces completion via a transcript message. Tasks whose allowlist includes `edit`, `write`, or `bash` mutate the shared working tree: they must declare `allowTreeMutation: true` (otherwise that task is refused) and always run **sequentially**, one at a time, after the parallel read-only batch completes — never concurrently with each other or the read-only batch.
- **`fleet` tool** (model-facing) — `list` shows queued/running runs owned by the current Pi session. Pass `scope: "all"` for persisted machine-wide history, or fetch a `result` directly by runId. This is how the model checks on background dispatches without mixing in unrelated sessions.
- **`/fleet` command** — user-facing active-run table. `/fleet all` opens persisted machine-wide history; `/fleet <runId-prefix>` jumps to a historical result.
- **Fleet radar overlay + statusline** — `Alt+Ctrl+F` (rebind via `~/.pi/agent/keybindings.json`) opens a tmux-choose-tree-style overlay listing active runs owned by the current Pi session as per-child lanes: status, model, current tool, token burn, last activity. `Enter` inspects the live run transcript; `c` cancels the focused run (wired into the cascading-cancellation registry); `Esc` closes. The ambient footer segment (`ctx.ui.setStatus`) exists only while this session owns queued/running subagents; runs from other sessions never make it appear.
- **`/patches` command** — staging area for worktree-subagent `.patch` handoffs. Opens a keyboard-driven overlay over every pending patch with diffstat and a pre-flight stamp (`clean` / `conflicts` / `stale`, checked via `git apply --check` **without** applying). `Enter` applies the whole patch (`git apply --3way`); `e` expands the full diff with per-hunk navigation (`n`/`p`); `s` applies the focused hunk; `d` discards. Apply/discard decisions persist to `~/.pi/agent/subagent-patches/state.json` so `/patches` survives restart.
- **`&` dispatch prefix** — `&scout how does auth work` at position zero dispatches a single subagent inline (reusing the same spawn/cancel path as the `dispatch` tool). Live progress shows in a widget above the editor; the final result lands as a collapsible `subagents:inline` transcript block rendered with the same vocabulary as a dispatch tool result, and the answer reaches the model's context. Each dispatch is captured as a session custom entry so it survives restart.
- **`/again [amendment]` command** — re-fires the last `&` dispatch verbatim, or with the amendment appended.
- **Durable runs** — a subagent cut off by pi quitting, crashing, or reloading resumes where it stopped the next time you open its session, in its worktree, from its own transcript. Its answer lands in the transcript as a `Resumed subagent … completed` notice. See **Durable runs** below.
- **Profiles (personas)** — named agent-definition markdown files bundling a skill basket, tool allowlist, model, and system prompt. A dispatch task passes `profile: "reviewer"` (or the editor uses `&reviewer …`) instead of hand-assembling those per task. See **Profiles** below.

## Usage

Ask naturally:

```text
Dispatch three reviewers: one for correctness, one for tests, one for unnecessary complexity.
```

```text
Dispatch a background scout to map the auth module while we keep working.
```

```text
Check the fleet for that background run's result.
```

or directly:

```text
/fleet       # active runs owned by this session
/fleet all   # persisted machine-wide history
```

### Inline `&` dispatch

Prefix a prompt with `&` to dispatch a single subagent inline — the run reuses the same spawn/cancel path as the `dispatch` tool, but is driven from the editor instead of the model:

```text
&scout how does auth work
```

Live progress shows in a widget above the editor; when the child settles, the result lands in the transcript as a collapsible block (same vocabulary as a `dispatch` tool result) and the answer is added to the model's context. The dispatch is recorded as a session entry, so `/again` can re-fire it:

```text
/again
/again focus only on the JWT path
```

`/again` re-fires the last `&` dispatch verbatim, or with an amendment appended. Cancellation: an inline run is registered in the cascading-cancellation registry, so it is aborted on session shutdown and can be cancelled mid-flight from the fleet radar (`Alt+Ctrl+F` → `c`) or the `fleet` tool — it is **not** aborted by a bare Esc (the `input` event fires while idle, so no agent abort signal is available to thread in).

### Worktree isolation

Builder tasks should prefer `worktree: true` over `allowTreeMutation: true`:

```json
{
  "tasks": [
    {
      "task": "Implement the parser in packages/foo",
      "tools": ["read", "edit", "write", "bash", "grep"],
      "worktree": true
    }
  ]
}
```

The child runs in a detached worktree at `~/.pi/agent/subagent-worktrees/<runId>` from current `HEAD`. Its writes never touch your working tree, mutating tools stay **parallel** (no `allowTreeMutation`, no serialization), and on completion the full change set — **including new untracked files** — is captured as an untruncated patch at `~/.pi/agent/subagent-runs/subagents/<runId>.patch`. Integration is your call (the central-integrator pattern): inspect the patch, `git apply` what you want. `fleet` `action: 'result'` shows the worktree path, patch path, and changed-file count. Fails fast if the cwd isn't a git repo.

#### `/patches` staging area

Instead of hunting for `.patch` files by hand, run `/patches`. It scans every completed worktree run's patch alongside its run artifact, pre-flights each one **without applying** (`git apply --check`), and stamps it:

- `clean` — applies cleanly to the current tree.
- `conflicts` — `--check` fails; the context no longer matches (inspect before applying).
- `stale` — a modified (non-created) target file no longer exists in the working tree.

Keys in the overlay: `↑↓` select, `Enter` applies the whole patch (`git apply --3way`), `e` expands the full diff with per-hunk navigation, `s` applies the focused hunk, `d` discards, `Esc` closes. Apply/discard decisions persist to `~/.pi/agent/subagent-patches/state.json`, so already-applied or discarded patches don't re-appear after restart.

Cuts (honest): `s` applies a **single focused hunk** (reconstructed as a sub-patch with its file header and `git apply --3way`-ed); multi-hunk selection is not implemented. The full-diff view is capped at 2000 lines (truncated with a marker) so an enormous patch can't swamp the overlay. The pre-flight stamp is a heuristic: `stale` vs `conflicts` is decided by whether a modified target file still exists, not by a true base-commit comparison (the run record doesn't store the base commit).

#### Worktree cleanup policy

- **Completed / failed / empty / schema-invalid runs** (the child finished): the worktree and its `.patch` are kept side-by-side under `~/.pi/agent/subagent-runs/subagents/` for a **7-day inspection window**, then removed together by the startup GC sweep (the `.json` artifact, the `.patch`, and the worktree itself). This is the "kept until artifact GC" window the fleet result view refers to.
- **Cancelled runs** (Esc/interrupt or `fleet` `cancel`): the child did not complete, so no `.patch` is captured and the worktree is **removed immediately** — a cancel can never leak a detached worktree. The worktree path is dropped from the run record, so `/fleet` never advertises a path that no longer exists.
- **Interrupted runs** (pi quits, reloads, switches session, or dies): the worktree is **kept** so the run can resume in it (see **Durable runs**). After a hard exit (SIGKILL, crash, power loss) the next host startup marks any `running`/`queued` record whose `hostPid` is no longer alive as interrupted. A ghost run with no resume record (another extension's run, or one from an in-memory session) is reaped as `aborted` and **its worktree is removed at reap time**. The 7-day age GC is the final backstop for both.
- **Unclaimed `.patch` files**: a `.patch` only exists for a finished run that changed files, and is always a sibling of its `<runId>.json` artifact. It is removed exactly when its artifact is removed — either by the 7-day age GC, or never (if the artifact is still fresh). There is no code path that deletes an artifact but leaves its patch behind, and no code path that writes a patch without an artifact.

#### Cascading cancellation

Esc/interrupt deterministically kills **all** running children — foreground and background alike:

- **Foreground tasks** are aborted through the tool `signal` pi passes to `dispatch`'s `execute()`; the abort propagates to the child `AgentSession.abort()`.
- **Background tasks** deliberately carry no tool signal (pi aborts tool signals once `execute()` returns, which would kill them prematurely), so they are tracked in a single live `runId → AbortController` registry. A `session_shutdown` handler (quit / reload / `/new` / `/resume` / `/fork`) walks that registry and stops every active run with the `HOST_EXIT` reason. That marks each one **interrupted** rather than cancelled, and the handler waits up to 5 s for them to record it. Quitting pi or replacing the session can't orphan a background run, and none of their work is lost.
- The `fleet` tool's `cancel` action aborts a single run by runId prefix.
- Worktree runs that are cancelled tear their worktree down immediately; interrupted runs keep theirs to resume in; completed runs keep theirs for the inspection window (see the cleanup policy above).

A hard `SIGKILL` of the host can't be intercepted from an extension: in-process children die instantly (they share the host's event loop), and their `running` records stay until the next host startup marks them interrupted.

### Durable runs

Every dispatch run (tool, background, or inline `&`) owned by a saved pi session is durable:

- **The transcript is written as the child runs.** The child's own session is a standard pi JSONL (see below), appended after every message, so a crash loses at most the reply in flight.
- **Interruption is recorded, not treated as a cancel.** On quit/reload/session switch the run is marked `interrupted` (`/fleet all` shows `interrupted`); after a crash the next startup does the same. Its worktree is kept.
- **Reopening the session resumes it.** On `session_start` the extension resumes every interrupted run that this session owns. Each one keeps its runId, model, tools, prompt, and worktree, and the child gets its transcript back plus _"You were interrupted… continue from where you left off"_. Pi fills in a placeholder result for any tool call that was in flight. Resumed runs show in the background widget and fleet like any background run. When one finishes, a `Resumed subagent <id> (<label>) completed` notice lands in the transcript with its answer, since the tool call that started it is gone. A run interrupted before its first reply starts over from its prompt.
- **Cancel stays a cancel.** Esc and `fleet` `cancel` abort for good: no resume, worktree removed.

Caveats: runs resume only when you reopen the **same** session (a `/fork` or new session doesn't inherit them), and only in an interactive or RPC session. Print mode (`pi -p`) never resumes. Resuming happens automatically with no opt-out; cancel an unwanted one from the fleet radar. A resumed run's timeout and turn/tool budgets start fresh. If the session is open in two pi processes at once, both can resume the same run.

## How it works

`dispatch` maps each task to a `spawn()` call on a shared in-process runtime (`namespace: "subagents"`). Foreground tasks run concurrently (the runtime caps parallelism, default 4) and their results return as the tool output. Background tasks use `spawnDetached()` and report completion via a transcript message.

Every run persists a record to `~/.pi/agent/subagent-runs/subagents/<runId>.json` (status, timing, usage, bounded output, and owning parent-session path). Because pi isolates module state per extension, this directory is the cross-extension fleet view: any extension using `@nicknisi/pi-shared` with the same artifacts root can appear in `/fleet all`. The default fleet filters those records to queued/running children whose `ownerSession` matches the current Pi session.

### Standard pi session per run

Every dispatch run is **also** written as a standard pi session JSONL by pi's real `SessionManager` (from `@earendil-works/pi-coding-agent`), as the child runs, into the default sessions dir (`~/.pi/agent/sessions/<encoded-cwd>/`), with the session header's `parentSession` set to the owning pi session's file path (read from `ctx.sessionManager.getSessionFile()` inside the `dispatch` tool). This means a subagent run shows up in pi's native `/resume` list, can be inspected with `/tree`, and can be branched/forked with `--fork` — exactly like a session you drove yourself. Because it's written live, it is also what a [durable run](#durable-runs) resumes from. The `fleet` tool's `result` view prints its path (`session: <path> (pi /resume, /tree, --fork)`).

This is **additive**, not a replacement: the bespoke `.json` run store above is unchanged, and the fleet/registry still read it (it carries bounded output, transcripts, worktree/patch info, and the cross-extension fleet view that the sessions dir doesn't encode). The session file carries the full message transcript instead.

Compat caveats:

- The session file is written only when the owning pi session is persisted (i.e. `getSessionFile()` returns a path). In-memory hosts (e.g. `pi -p --no-session`) have no owning session file, so none is written and the run isn't durable — the bespoke `.json` record is still the source of truth.
- pi writes the file at the child's first reply, so a run that ended before replying has none; `record.sessionFile` is left undefined rather than advertising a near-empty session.
- The session file holds the child's messages as pi sees them (user prompt → assistant turns → tool results). It does **not** carry the subagent-specific metadata (runId, namespace, transcript summary, worktree/patch paths) — that lives only on the bespoke `.json` artifact, which is why both are kept.
- Worktree-isolated runs record the **worktree's** cwd (where the child actually ran), not the caller's cwd. The session header's `cwd` is honest about where the work happened.

Children are **hermetic by construction**: no user extensions, skills, prompt templates, themes, or `AGENTS.md` context load unless explicitly requested. Tool scoping is likewise by construction — a child receives exactly its allowlist, and no spawn capability exists as a tool, so children cannot recurse. The ecosystem recursion guard (`PI_SUBAGENT_DEPTH` / `PI_SUBAGENT_CHILD`) is honored: inside a pi-subagents child, spawns are refused.

`spawn()` never rejects; results are a discriminated union (`ok | crashed | empty | schema_invalid | aborted`). See `packages/shared/README.md` for the full runtime API.

### Models: children use the parent's registry

Children resolve models against the **parent session's model registry**, not a fresh one. So a provider the host registered at runtime (`pi.registerProvider(...)`, e.g. a Cloudflare AI Gateway provider whose requests carry only `cf-aig-authorization`) reaches every child with its auth and headers, and no token is written to disk or env.

- **No `model` on a task** → the child runs on the **parent session's current model** (a gateway worker's children stay on the gateway model).
- **`model: "provider/id"`** (on a task or profile) → resolved against that same registry, so runtime-registered providers work there too.
- `workflows` and `llm-council` children behave the same way.

pi exposes no public accessor for a registry's runtime, so the shared runtime reads `ModelRegistry`'s private `runtime` field (checked against pi-coding-agent 0.84, 0.87 and 1.1). If a pi upgrade renames it, children fall back to replaying the parent's runtime-registered providers into a fresh runtime (one console warning). That keeps gateway-style providers working but loses runtime-only API keys (`--api-key`) and host-supplied credential stores.

### Where runtime files go (`PI_SUBAGENTS_DIR`)

By default everything the runtime writes lives under the pi agent dir, as described above. Set **`PI_SUBAGENTS_DIR`** to move all of it under one root, e.g. a host confining a job to its own directory:

| Default                                                   | With `PI_SUBAGENTS_DIR=<root>` |
| --------------------------------------------------------- | ------------------------------ |
| `~/.pi/agent/subagent-runs/` (records, `.patch` handoffs) | `<root>/runs/`                 |
| `~/.pi/agent/subagent-patches/state.json`                 | `<root>/patches/state.json`    |
| `~/.pi/agent/subagent-worktrees/<runId>`                  | `<root>/worktrees/<runId>`     |
| `~/.pi/agent/sessions/<encoded-cwd>/` (run sessions)      | `<root>/sessions/`             |
| `~/.pi/agent/workflow-runs/` (shared `runWorkflow`)       | `<root>/workflow-runs/`        |

It is read when the extension starts and at each write, not at import. Config stays put: profiles, keybindings, and workflows still come from the agent dir. Run sessions under the override are outside pi's sessions dir, so `/resume` won't list them (open them by path).

## Profiles

A profile is a markdown file — frontmatter on top, persona system prompt below — that names a reusable child persona: which skills it carries, which tools it may use, optionally which model it runs, and how it should behave. Hermetic children get **no** skills by default; a profile is the curated basket that opts specific ones in.

```markdown
---
name: reviewer
description: Code review — correctness, tests, simplicity
skills: pr, review-checklist
tools: read, grep, find, ls
model: anthropic/claude-sonnet-4-5
---

Review the change against the task. Prefer the smallest correct fix.
```

| Field         | Meaning                                                                                                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`        | Profile name (defaults to the file stem).                                                                                                                                                                                                                    |
| `description` | Required — shown in the dispatch tool's profile catalog.                                                                                                                                                                                                     |
| `skills`      | Skill basket: bare names resolve against the parent session's skill catalog (wherever pi discovered them — user dir, project, packages, `--skill` flags); entries with a `/` or `.md` resolve relative to the profile file. Missing skills warn, never fail. |
| `tools`       | Tool allowlist. Omitted = dispatch's read-only default.                                                                                                                                                                                                      |
| `model`       | Optional model spec.                                                                                                                                                                                                                                         |
| `worktree`    | Default the task to worktree isolation — set this on builder personas so their `edit`/`write`/`bash` tools stay parallel and need no `allowTreeMutation`.                                                                                                    |
| `replace`     | Replace pi's system prompt with the persona prompt instead of appending.                                                                                                                                                                                     |

Lists accept comma-separated scalars or `- item` block lists. Unknown keys are ignored, so agent files shared with other harnesses load. The parser is deliberately small — flat `key: value` frontmatter, not full YAML.

For compatibility with legacy read-only profiles, inherited `bash` is omitted when the profile has no `edit` or `write` tools and the task does not set `worktree: true` or `allowTreeMutation: true`. An explicit task `tools` list is never changed.

**Discovery** (first-wins by name, highest precedence first):

1. `<cwd>/.pi/agents/*.md` — project profiles
2. `~/.pi/agent/agents/*.md` — user profiles
3. Host-provided extra dirs (`SubagentsOptions.profileDirs`) — e.g. a distribution's bundled defaults

Dirs are rescanned on each dispatch, so edits apply without a restart (the tool _description_'s profile catalog refreshes on session start).

**Merge semantics:** explicit task fields win — call beats persona, persona beats defaults. `profile` on a dispatch task is strict: an unknown name refuses that task and lists the known profiles. The `&` prefix resolves softly: `&reviewer fix this` applies the `reviewer` profile when it exists and otherwise keeps the old plain-label behavior. `replace` applies only when the persona's own prompt is used.

```json
{ "tasks": [{ "task": "Review this diff for correctness", "profile": "reviewer" }] }
```

## Configuration

None required. Embedders can pass options through the factory:

```ts
import subagents from '@nicknisi/pi-subagents';

export default (pi: ExtensionAPI) => subagents(pi, { profileDirs: ['/path/to/bundled/profiles'] });
```

`profileDirs` appends lowest-precedence profile directories — the hook for a distribution (e.g. arc) to ship default personas that user and project files can shadow.

## Tool exposure

`fleet` registers with `exposure: "deferred"` (pi ≥0.99; `dispatch` stays always declared), so it stays out of the system prompt when pi's built-in `tool_search` is active (`"defaultTools": ["+tool_search"]`): the model finds it on demand. Without `tool_search` the extension declares it directly at session start, as before. Older pi ignores the field. It also carries `annotations` (read-only/destructive/open-world hints) for permission extensions.

## Caveats

- **In-process means no crash isolation.** Children share the parent session's event loop and memory; a pathological child can hurt the host. Untrusted or heavy parallel work should stay on pi-subagents (or a future RPC transport) until this platform grows an isolation option.
- **Background completion is a notification, not a turn.** The completion message lands in the transcript but doesn't drive the agent — the model learns results when it next acts (or when asked to check `fleet`).
- **Fleet history is per-machine, per-agent-dir.** `/fleet all` reads records under `~/.pi/agent/subagent-runs/` (or `$PI_SUBAGENTS_DIR/runs/`); they are garbage-collected at startup after 7 days (along with their patches and worktrees). The default `/fleet`, shortcut, tool list, and footer are current-session active views.
- **Runs execute only while their host session is open.** They are detached in-process children: pi exiting or switching sessions interrupts them, and they continue when that session reopens (see **Durable runs** above). Cancel one for good with the `fleet` tool (`action: 'cancel'`).
- Depends on pi SDK internals (`createAgentSession`, `DefaultResourceLoader` flags, `SessionManager.inMemory`) that could change across pi versions — runtime-aliased to the host at load time, but type-level drift would surface at extension load.
- **The recursion guard has a hole.** The in-process depth guard only covers spawns made through the shared runtime; a child that itself shells out to `pi -p` via bash starts a fresh process with none of that context — the same exposure as any pi session with bash access.
