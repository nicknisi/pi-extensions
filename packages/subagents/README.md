# @nicknisi/pi-subagents

First-party subagent dispatch and fleet for pi — fan out parallel child agents and inspect their runs, with **no dependency on pi-subagents**. Children are hermetic in-process agent sessions spawned through `@nicknisi/pi-shared`'s runtime (`createAgentSession` under the hood): fast to start, version-matched to the running pi, and unable to spawn children of their own.

## What it adds

- **`dispatch` tool** (model-facing) — fan out up to 8 child agents in parallel. Each task gets its own prompt, optional label/model/system-prompt, and a tool allowlist (default read-only: `read`, `grep`, `find`, `ls`). Typed per-task results aggregate into one tool result. `background: true` runs detached and surfaces completion via a transcript message.
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
- **The fleet is per-machine, per-agent-dir.** Records live under `~/.pi/agent/subagent-runs/`; nothing prunes old records yet.
- Depends on pi SDK internals (`createAgentSession`, `DefaultResourceLoader` flags, `SessionManager.inMemory`) that could change across pi versions — runtime-aliased to the host at load time, but type-level drift would surface at extension load.
