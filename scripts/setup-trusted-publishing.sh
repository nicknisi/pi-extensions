#!/usr/bin/env bash
# One-time setup: publish all packages to npm (creating them), then attach
# a GitHub Actions trusted publisher to each via `npm trust`.
#
# Prereqs:
#   npm >= 11.15.0
#   npm login --registry=https://registry.npmjs.org   (interactive, account 2FA on)
#
# The first `npm trust` call prompts for 2FA — choose the "skip for 5 minutes"
# option on the npm website and the remaining packages go through unattended.
set -euo pipefail

REGISTRY="https://registry.npmjs.org"
REPO="nicknisi/pi-extensions"
WORKFLOW="release.yml"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

npm whoami --registry="$REGISTRY" >/dev/null 2>&1 || {
  echo "not logged in: run  npm login --registry=$REGISTRY" >&2
  exit 1
}

# Phase 1: publish packages that don't exist on npm yet.
# `pnpm publish` (not npm) so workspace:* ranges rewrite to real versions.
publish_pkg() {
  local dir="$1" name version
  name="$(node -p "require('$ROOT/packages/$dir/package.json').name")"
  version="$(node -p "require('$ROOT/packages/$dir/package.json').version")"
  # NOTE: `npm view <name>` can 404 on a lagging read replica minutes after a
  # successful publish (this happened with pi-relay). Query the exact version
  # endpoint instead — it reads authoritatively — and treat a 403
  # 'previously published' from the publish attempt itself as success.
  if curl -sf "$REGISTRY/$(echo "$name" | sed 's|/|%2f|')/$version" >/dev/null 2>&1; then
    echo "== $name@$version already on npm, skipping publish"
  else
    echo "== publishing $name@$version"
    if ! (cd "$ROOT/packages/$dir" && pnpm publish --access public --no-git-checks --registry="$REGISTRY"); then
      if curl -sf "$REGISTRY/$(echo "$name" | sed 's|/|%2f|')/$version" >/dev/null 2>&1; then
        echo "== $name@$version showed up after the failed publish (replica lag) — continuing"
      else
        echo "!! publish of $name failed for real" >&2
        exit 1
      fi
    fi
    sleep 2
  fi
}

# shared first — six packages depend on it
publish_pkg shared
for dir in "$ROOT"/packages/*/; do
  dir="$(basename "$dir")"
  [ "$dir" = "shared" ] && continue
  publish_pkg "$dir"
done

# Phase 2: attach the trusted publisher to each package.
for dir in "$ROOT"/packages/*/; do
  dir="$(basename "$dir")"
  name="$(node -p "require('$ROOT/packages/$dir/package.json').name")"
  if npm trust list "$name" --registry="$REGISTRY" 2>/dev/null | grep -q "$WORKFLOW"; then
    echo "== $name already trusts $REPO/$WORKFLOW, skipping"
    continue
  fi
  # NOTE: `npm trust list` itself can require 2FA and fail silently above —
  # so also treat a 409 from the create call as 'already configured' (npm
  # allows exactly one trusted publisher per package).
  echo "== trusting $name -> $REPO ($WORKFLOW)"
  if npm trust github "$name" --file "$WORKFLOW" --repo "$REPO" --allow-publish --yes --registry="$REGISTRY" 2>&1 | tee /tmp/npm-trust-$$.log | grep -q "E409\|409 Conflict"; then
    echo "== $name already has a trusted publisher (409) — verify it's $REPO/$WORKFLOW in the npm UI"
  elif [ "${PIPESTATUS[0]}" -ne 0 ]; then
    echo "!! trust failed for $name" >&2
    cat /tmp/npm-trust-$$.log >&2
    rm -f /tmp/npm-trust-$$.log
    exit 1
  fi
  rm -f /tmp/npm-trust-$$.log
  sleep 2
done

echo "done — all packages published and trusting $REPO via $WORKFLOW"
