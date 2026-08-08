# @nicknisi/pi-subagents

First-party subagent dispatch and fleet for pi — fan out parallel child agents and inspect their runs, with **no dependency on pi-subagents**. Children are hermetic in-process agent sessions spawned through `@nicknisi/pi-shared`'s runtime (`createAgentSession` under the hood): fast to start, version-matched to the running pi, and unable to spawn children of their own.

## What it adds

- **`dispatch` tool** (model-facing) — fan out up to 8 child agents in parallel. Each task gets its own prompt, optional label/model/system-prompt, and a tool allowlist (default read-only: `read`, `grep`, `find`, `ls`). Typed per-task results aggregate into one tool result. `background: true` runs detached and surfaces completion via a transcript message. Tasks whose allowlist includes `edit`, `write`, or `bash` mutate the shared working tree: they must declare `allowTreeMutation: true` (otherwise that task is refused) and always run **sequentially**, one at a time, after the parallel read-only batch completes — never concurrently with each other or the read-only batch.
- **`fleet` tool** (model-facing) — `list` recent runs (live + persisted, across extensions using the shared runtime) or fetch a `result` by runId. This is how the model checks on background dispatches.
- **`/fleet` command** — user-facing run table.

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
/fleet
```

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

#### Worktree cleanup policy

- **Completed / failed / empty / schema-invalid runs** (the child finished): the worktree and its `.patch` are kept side-by-side under `~/.pi/agent/subagent-runs/subagents/` for a **7-day inspection window**, then removed together by the startup GC sweep (the `.json` artifact, the `.patch`, and the worktree itself). This is the "kept until artifact GC" window the fleet result view refers to.
- **Aborted runs** (Esc/interrupt, `fleet` `cancel`, or host shutdown): the child did not complete, so no `.patch` is captured and the worktree is **removed immediately** — an interrupt or parent exit can never leak a detached worktree. The worktree path is dropped from the run record, so `/fleet` never advertises a path that no longer exists.
- **Hard exit** (SIGKILL, crash, power loss) that skips the graceful shutdown handler: any `running`/`queued` record whose `hostPid` is no longer alive is reaped as `aborted` on the next host startup, and **its worktree is removed at reap time** — so even an ungraceful kill cannot strand a worktree long-term (the 7-day age GC is the final backstop).
- **Unclaimed `.patch` files**: a `.patch` only exists for a finished run that changed files, and is always a sibling of its `<runId>.json` artifact. It is removed exactly when its artifact is removed — either by the 7-day age GC, or never (if the artifact is still fresh). There is no code path that deletes an artifact but leaves its patch behind, and no code path that writes a patch without an artifact.

#### Cascading cancellation

Esc/interrupt deterministically kills **all** running children — foreground and background alike:

- **Foreground tasks** are aborted through the tool `signal` pi passes to `dispatch`'s `execute()`; the abort propagates to the child `AgentSession.abort()`.
- **Background tasks** deliberately carry no tool signal (pi aborts tool signals once `execute()` returns, which would kill them prematurely), so they are tracked in a single live `runId → AbortController` registry. A `session_shutdown` handler (quit / reload / `/new` / `/resume` / `/fork`) walks that registry and aborts every active controller, so quitting pi or replacing the session cannot orphan a background run.
- The `fleet` tool's `cancel` action aborts a single run by runId prefix.
- Worktree runs that are aborted tear their worktree down immediately (see the cleanup policy above); completed runs keep theirs for the inspection window.

The one residual exposure is a hard `SIGKILL` of the host: in-process children die instantly (they share the host's event loop), but their worktrees and `running` records linger until the next host startup reaps them. There is no way to intercept `SIGKILL` from an extension; the startup reap + 7-day GC are the backstop.

## How it works

`dispatch` maps each task to a `spawn()` call on a shared in-process runtime (`namespace: "subagents"`). Foreground tasks run concurrently (the runtime caps parallelism, default 4) and their results return as the tool output. Background tasks use `spawnDetached()` and report completion via a transcript message.

Every run persists a record to `~/.pi/agent/subagent-runs/subagents/<runId>.json` (status, timing, usage, bounded output). Because pi isolates module state per extension, this directory is the cross-extension fleet view: any extension using `@nicknisi/pi-shared` with the same artifacts root shows up in `/fleet`.

### Standard pi session mirror

Every dispatch run is **also** dual-written as a standard pi session JSONL via pi's real `SessionManager` (from `@earendil-works/pi-coding-agent`), into the default sessions dir (`~/.pi/agent/sessions/<encoded-cwd>/`), with the session header's `parentSession` set to the owning pi session's file path (read from `ctx.sessionManager.getSessionFile()` inside the `dispatch` tool). This means a subagent run shows up in pi's native `/resume` list, can be inspected with `/tree`, and can be branched/forked with `--fork` — exactly like a session you drove yourself. The `fleet` tool's `result` view prints the mirror path (`session: <path> (pi /resume, /tree, --fork)`).

This is **additive dual-write**, not a replacement: the bespoke `.json` run store above is unchanged, and the fleet/registry still read it (it carries bounded output, transcripts, worktree/patch info, and the cross-extension fleet view that the sessions dir doesn't encode). The session mirror carries the full message transcript instead.

Compat caveats:

- The mirror is written only when the owning pi session is persisted (i.e. `getSessionFile()` returns a path). In `pi -p` print mode or other in-memory hosts there is no owning session file, so no mirror is written — the bespoke `.json` record is still the source of truth.
- `SessionManager` creates the JSONL lazily — only once the first assistant message is appended. A run that crashed before producing any assistant turn (kind `crashed`/`empty` with no assistant message) leaves no session file on disk; `record.sessionFile` is left undefined in that case rather than advertising a path to nothing.
- The mirror reflects the child's messages as pi sees them (user prompt → assistant turns → tool results). It does **not** carry the subagent-specific metadata (runId, namespace, transcript summary, worktree/patch paths) — that lives only on the bespoke `.json` artifact, which is why both are kept.
- Worktree-isolated runs mirror with the **worktree's** cwd (where the child actually ran), not the caller's cwd. The session header's `cwd` is honest about where the work happened.

Children are **hermetic by construction**: no user extensions, skills, prompt templates, themes, or `AGENTS.md` context load unless explicitly requested. Tool scoping is likewise by construction — a child receives exactly its allowlist, and no spawn capability exists as a tool, so children cannot recurse. The ecosystem recursion guard (`PI_SUBAGENT_DEPTH` / `PI_SUBAGENT_CHILD`) is honored: inside a pi-subagents child, spawns are refused.

`spawn()` never rejects; results are a discriminated union (`ok | crashed | empty | schema_invalid | aborted`). See `packages/shared/README.md` for the full runtime API.

## Configuration

None. No config files, no environment variables.

## Caveats

- **In-process means no crash isolation.** Children share the parent session's event loop and memory; a pathological child can hurt the host. Untrusted or heavy parallel work should stay on pi-subagents (or a future RPC transport) until this platform grows an isolation option.
- **Background completion is a notification, not a turn.** The completion message lands in the transcript but doesn't drive the agent — the model learns results when it next acts (or when asked to check `fleet`).
- **The fleet is per-machine, per-agent-dir.** Records live under `~/.pi/agent/subagent-runs/` and are garbage-collected at startup after 7 days (along with their patches and worktrees).
- **Background runs live only as long as the host session.** They are detached in-process children; cancel them via the `fleet` tool (`action: 'cancel'`), or let the `session_shutdown` handler abort them deterministically on quit/reload/session-replacement (see **Cascading cancellation** above). Running records left by a hard exit are reaped as `aborted` (and their worktrees removed) on the next host startup.
- Depends on pi SDK internals (`createAgentSession`, `DefaultResourceLoader` flags, `SessionManager.inMemory`) that could change across pi versions — runtime-aliased to the host at load time, but type-level drift would surface at extension load.
- **The recursion guard has a hole.** The in-process depth guard only covers spawns made through the shared runtime; a child that itself shells out to `pi -p` via bash starts a fresh process with none of that context — the same exposure as any pi session with bash access.
