# pi-extensions — Agent Instructions

Monorepo of Nick Nisi's pi extensions. Each `packages/<name>/` is an independently published npm package (`@nicknisi/pi-<name>`) installable via `pi install`.

## Hard rules

- **Conventional commits are required** (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:` …). PR titles must be conventional — CI enforces it (`lint-pr-title`), and the PR title becomes the main-branch commit. Squash is the only merge method enabled and `main` requires linear history, so every PR lands as exactly one conventional commit; branch commits are free-form working history.
- **Add a changeset for any user-facing change** to a package: run `pnpm changeset`, pick the packages + bump, and commit the generated file with your change. No changeset = no release. (Docs/config/CI-only changes don't need one.)
- Never edit a package's behavior during a structural move or rename.

## Workflow

```bash
pnpm install
pnpm typecheck     # tsgo (TS 7 native preview)
pnpm lint          # oxlint
pnpm format        # oxfmt (format:check to verify)
```

- Extensions ship `.ts` source directly — no build step. `@earendil-works/*` are peer deps; pi's runtime aliases them at load time.
- Cross-package helpers go in `packages/shared` (`@nicknisi/pi-shared`, `workspace:*`).
- Runtime configs live in `~/.pi/agent/configs/`, not in this repo.

## Adding a new extension

1. **Scaffold**: `mkdir packages/<name>` with `index.ts` (default-export the extension factory) and `package.json`. Copy an existing simple package (e.g. `packages/stash/package.json`) as the template — it already has the right shape: `@nicknisi/pi-<name>` name, `pi` manifest (`"extensions": ["./index.ts"]`), `exports`, `files`, `license`, `repository`+`homepage` fields, `keywords: ["pi-package"]`, and `@earendil-works/*` as peerDependencies only.
2. **Shared helpers** go in `packages/shared`, consumed as `"@nicknisi/pi-shared": "workspace:*"`.
3. **README**: write a thorough `packages/<name>/README.md` — what it adds (commands/tools/widgets/entry types), usage examples, full config schema with defaults, dependencies, caveats (pi internals, platform assumptions). Match the depth of the existing ones.
4. **Top-level README**: add the package to the right table in the root `README.md`.
5. **Verify**: `pnpm typecheck && pnpm lint && pnpm format`, then smoke-test the load: add the package path to a scratch agent dir's settings and run `pi -p` — pi reports extension load errors loudly.
6. **Changeset**: `pnpm changeset` (patch/minor for new packages) committed with the change.
7. **PR it** — branch protection requires the `Check` and `lint` status checks.
8. **After merge**: new packages aren't on npm until first publish, and trusted publishing must be attached per package. Run `scripts/setup-trusted-publishing.sh` — it publishes anything missing and runs `npm trust` for it (idempotent).

## Releases

Changesets + npm trusted publishing (OIDC). Merging the "chore: version packages" PR publishes to npm and tags. Details: `.github/workflows/release.yml`.
