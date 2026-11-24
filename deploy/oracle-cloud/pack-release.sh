#!/usr/bin/env bash
# Pack a table-server release (run by .github/workflows/deploy.yml, after the table web bundle and
# data/table-oracle-cards.json are built):
#
#   bash deploy/oracle-cloud/pack-release.sh <commit> <out-dir>
#
# Writes <out-dir>/server-<short>.tar.gz and its .sha256, and prints tag=server-<short> to
# $GITHUB_OUTPUT when set. The archive unpacks to a directory the service runs from as it is: the
# server sources at that commit, production dependencies, the table web bundle, the card file, the
# banned list, and release.json naming the commit. Tests and docs stay out.
set -euo pipefail

COMMIT="${1:?usage: pack-release.sh <commit> <out-dir>}"
OUT="${2:?usage: pack-release.sh <commit> <out-dir>}"
if ! [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "pack-release: expected a full commit SHA, got '$COMMIT'" >&2
  exit 1
fi
TAG="server-${COMMIT:0:12}"
for required in apps/web/dist-table/index.html data/table-oracle-cards.json; do
  [[ -f "$required" ]] || { echo "pack-release: missing $required; build it first" >&2; exit 1; }
done

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ROOT="$STAGE/$TAG"
mkdir -p "$ROOT"

# The sources at the commit, not the working tree: only what is committed ships.
git archive "$COMMIT" package.json bun.lock 'tsconfig*.json' packages apps/web/package.json \
  docs/rules/commander-banned-list.md | tar -x -C "$ROOT"
# Every workspace's package.json, so the frozen lockfile installs.
git ls-tree -r --name-only "$COMMIT" -- packages apps | grep -E '^(packages|apps)/[^/]+/package\.json$' |
  xargs git archive "$COMMIT" | tar -x -C "$ROOT"
# Tests, fixtures for tests and type output never run on the server.
find "$ROOT/packages" \( -name '*.test.ts' -o -name 'dist' -o -name 'tests' \) -prune -exec rm -rf {} +

mkdir -p "$ROOT/apps/web" "$ROOT/data"
cp -R apps/web/dist-table "$ROOT/apps/web/dist-table"
cp data/table-oracle-cards.json "$ROOT/data/table-oracle-cards.json"
printf '{"commit":"%s","builtAt":"%s"}\n' "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$ROOT/release.json"

(cd "$ROOT" && bun install --frozen-lockfile --production --ignore-scripts)

mkdir -p "$OUT"
tar -C "$STAGE" -czf "$OUT/$TAG.tar.gz" "$TAG"
(cd "$OUT" && sha256sum "$TAG.tar.gz" > "$TAG.tar.gz.sha256")
ls -l "$OUT"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "tag=$TAG" >> "$GITHUB_OUTPUT"; fi
