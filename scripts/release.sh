#!/usr/bin/env bash
# Release helper for the `codetime` CLI package.
#
# Usage:
#   pnpm release [--dry] [--tag <tag>]
#
# Version bumping is intentionally out of scope — edit
# `packages/cli/package.json` (or use `pnpm --filter codetime version <bump>`)
# and commit before running this.
#
# What it does:
#   1. Verifies clean git tree + on main
#   2. Verifies npm auth
#   3. Installs deps + runs tests (which also builds)
#   4. Re-bundles via esbuild → bin/codetime.mjs
#   5. Publishes via `pnpm --filter codetime publish` with --access public
#   6. Tags + pushes (skipped in --dry)
#
# Prereqs: `npm login` once locally (or NODE_AUTH_TOKEN env in CI).

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_DIR="$ROOT_DIR/packages/cli"
cd "$ROOT_DIR"

# ── arg parsing ──
DRY_RUN=0
DIST_TAG="latest"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry|--dry-run) DRY_RUN=1; shift ;;
    --tag) DIST_TAG="${2:?missing tag value}"; shift 2 ;;
    --tag=*) DIST_TAG="${1#*=}"; shift ;;
    *) echo "release.sh: unknown arg: $1" >&2; exit 1 ;;
  esac
done

log() { printf "\033[1;36m▸\033[0m %s\n" "$*"; }
fail() { printf "\033[1;31m✗\033[0m %s\n" "$*" >&2; exit 1; }

# ── precondition: clean git tree ──
log "checking git state"
if [ -n "$(git status --porcelain)" ]; then
  fail "working tree not clean; commit or stash first"
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "main" ] && [ "$DRY_RUN" -eq 0 ]; then
  fail "not on main (current: $CURRENT_BRANCH). Use --dry to test from a branch."
fi

# ── precondition: npm auth (skip in dry-run) ──
if [ "$DRY_RUN" -eq 0 ]; then
  if ! npm whoami >/dev/null 2>&1; then
    fail "not logged in to npm. Run \`npm login\` first."
  fi
fi

# ── precondition: tag must not already exist on the remote ──
VERSION="$(node -p "require('$CLI_DIR/package.json').version")"
TAG="codetime@${VERSION}"
log "release version: $VERSION (dist-tag: $DIST_TAG)"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  fail "git tag $TAG already exists locally. Bump the version first."
fi

# ── full check ──
log "installing deps"
pnpm install --frozen-lockfile

log "running tests (includes build)"
pnpm test

# ── bundle ──
log "bundling CLI"
pnpm --filter codetime run build:bundle

# ── publish ──
PUBLISH_ARGS=(--filter codetime publish --access public --tag "$DIST_TAG" --no-git-checks)
if [ "$DRY_RUN" -eq 1 ]; then
  PUBLISH_ARGS+=(--dry-run)
  log "DRY RUN: pnpm ${PUBLISH_ARGS[*]}"
else
  log "publishing to npm"
fi
pnpm "${PUBLISH_ARGS[@]}"

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry run complete; no tag or push performed."
  exit 0
fi

# ── tag + push ──
log "tagging $TAG"
git tag -a "$TAG" -m "codetime@${VERSION}"
git push origin main --follow-tags

log "done. published codetime@${VERSION}"
