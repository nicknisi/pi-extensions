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

The child runs in a detached worktree at `~/.pi/agent/subagent-worktrees/<runId>` from current `HEAD`. Its writes never touch your working tree, mutating tools stay **parallel** (no `allowTreeMutation`, no serialization), and on completion the full change set — **including new untracked files** — is captured as an untruncated patch at `~/.pi/agent/subagent-runs/subagents/<runId>.patch`. Integration is your call (the central-integrator pattern): inspect the patch, `git apply` what you want. The worktree itself is kept until artifact GC (7 days) for manual inspection; `fleet` `action: 'result'` shows the worktree path, patch path, and changed-file count. Fails fast if the cwd isn't a git repo.

## How it works

`dispatch` maps each task to a `spawn()` call on a shared in-process runtime (`namespace: "subagents"`). Foreground tasks run concurrently (the runtime caps parallelism, default 4) and their results return as the tool output. Background tasks use `spawnDetached()` and report completion via a transcript message.

Every run persists a record to `~/.pi/agent/subagent-runs/subagents/<runId>.json` (status, timing, usage, bounded output). Because pi isolates module state per extension, this directory is the cross-extension fleet view: any extension using `@nicknisi/pi-shared` with the same artifacts root shows up in `/fleet`.

Children are **hermetic by construction**: no user extensions, skills, prompt templates, themes, or `AGENTS.md` context load unless explicitly requested. Tool scoping is likewise by construction — a child receives exactly its allowlist, and no spawn capability exists as a tool, so children cannot recurse. The ecosystem recursion guard (`PI_SUBAGENT_DEPTH` / `PI_SUBAGENT_CHILD`) is honored: inside a pi-subagents child, spawns are refused.

`spawn()` never rejects; results are a discriminated union (`ok | crashed | empty | schema_invalid | aborted`). See `packages/shared/README.md` for the full runtime API.

## Configuration

None. No config files, no environment variables.

## Caveats

- **In-process means no crash isolation.** Children share the parent session's event loop and memory; a pathological child can hurt the host. Untrusted or heavy parallel work should stay on pi-subagents (or a future RPC transport) until this platform grows an isolation option.
- **Background completion is a notification, not a turn.** The completion message lands in the transcript but doesn't drive the agent — the model learns results when it next acts (or when asked to check `fleet`).
- **The fleet is per-machine, per-agent-dir.** Records live under `~/.pi/agent/subagent-runs/` and are garbage-collected at startup after 7 days (along with their patches and worktrees).
- **Background runs live only as long as the host session.** They are detached in-process children; cancel them via the `fleet` tool (`action: 'cancel'`), and when the host exits, running children die with it — their persisted records are reaped as `aborted` on next startup.
- Depends on pi SDK internals (`createAgentSession`, `DefaultResourceLoader` flags, `SessionManager.inMemory`) that could change across pi versions — runtime-aliased to the host at load time, but type-level drift would surface at extension load.
- **The recursion guard has a hole.** The in-process depth guard only covers spawns made through the shared runtime; a child that itself shells out to `pi -p` via bash starts a fresh process with none of that context — the same exposure as any pi session with bash access.
