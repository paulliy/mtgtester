#!/usr/bin/env bash
# The VM's deploy agent (docs/guides/deploy-oracle-cloud.md, "Releases"). mtg-deploy.timer runs it
# every three minutes as root. Each run:
#
#   1. Reads the commit the server-live tag names on GitHub. Nothing to do when it is running.
#   2. Downloads server-<sha>.tar.gz from that release, checks its SHA-256, and unpacks it into
#      releases/<sha>.
#   3. Waits for the games in progress to end (`activeGames` on /health), up to WAIT_MINUTES.
#   4. Stops the server, copies the database to backups/, points `current` at the new release, and
#      starts the server.
#   5. Waits for /health to name the new commit. If it does not, it restores the database copy,
#      points `current` back, and starts the old release.
#
# A heartbeat URL (healthchecks.io) is pinged after every run that ends with the right release
# running, and its /fail URL after a rollback, so a silent agent or a failed deploy raises an alert.
# Settings: /etc/mtg-deploy.env (optional). Install: deploy/oracle-cloud/install-releases.sh.
set -euo pipefail

REPO="${REPO:-paulliy/mtgtester}"
APP_ROOT="${APP_ROOT:-/opt/mtgtester-releases}"
STATE_DIR="${STATE_DIR:-/var/lib/mtgtester}"
SERVICE="${SERVICE:-mtg-table}"
TABLE_ENV="${TABLE_ENV:-/etc/mtg-table.env}"
WAIT_MINUTES="${WAIT_MINUTES:-60}"
START_SECONDS="${START_SECONDS:-300}"
KEEP_RELEASES="${KEEP_RELEASES:-3}"
KEEP_BACKUPS="${KEEP_BACKUPS:-10}"
HEARTBEAT_URL="${HEARTBEAT_URL:-}"
API_BASE="${API_BASE:-https://api.github.com}"
DOWNLOAD_BASE="${DOWNLOAD_BASE:-https://github.com/$REPO/releases/download}"
LOCK_FILE="${LOCK_FILE:-/run/mtg-deploy.lock}"

log() { echo "deploy-agent: $*"; }
# The lock's descriptor stays out of anything the service starts.
unit() { systemctl "$1" "$SERVICE" 9>&-; }
ping_heartbeat() {
  [[ -n "$HEARTBEAT_URL" ]] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "$HEARTBEAT_URL${1:-}" || log "heartbeat ping failed"
}

# One run at a time: a slow wait for games must not overlap the next timer tick.
exec 9>"$LOCK_FILE"
flock -n 9 || { log "another run is in progress"; exit 0; }

# The server answers only its public host through the tunnel's loopback peer, so ask as the tunnel
# does: that Host, and a forwarded client address.
env_value() { sed -n "s/^$1=//p" "$TABLE_ENV" 2>/dev/null | tail -n 1; }
PORT="$(env_value TABLE_PORT)"
PORT="${PORT:-3002}"
HOST="$(env_value TABLE_ALLOWED_HOSTS | cut -d, -f1)"
HOST="${HOST:-127.0.0.1:$PORT}"
health() {
  curl -fs -m 5 -H "Host: $HOST" -H 'X-Forwarded-For: 127.0.0.1' "http://127.0.0.1:$PORT/health"
}
health_field() { sed -n "s/.*\"$1\":\"\{0,1\}\([^\",}]*\).*/\1/p"; }

running_release() {
  local target
  target="$(readlink "$APP_ROOT/current" 2>/dev/null || true)"
  basename "${target:-none}"
}

# 1. What should be live.
ref="$(curl -fsS -m 20 --retry 3 -H 'Accept: application/vnd.github+json' \
  "$API_BASE/repos/$REPO/git/ref/tags/server-live")" || {
  log "could not read the server-live tag"
  exit 1
}
want="$(printf '%s' "$ref" | tr -d ' \n' | sed -n 's/.*"object":{"sha":"\([0-9a-f]\{40\}\)".*/\1/p')"
if [[ -z "$want" ]]; then
  log "the server-live tag names no commit"
  exit 1
fi
tag="server-${want:0:12}"
have="$(running_release)"
if [[ "$have" == "$want" ]]; then
  live="$(health | health_field version || true)"
  if [[ "$live" == "$want" ]]; then
    ping_heartbeat
  else
    log "release $want is current but /health reports '${live:-nothing}'"
  fi
  exit 0
fi
if [[ "$(cat "$STATE_DIR/failed-release" 2>/dev/null || true)" == "$want" ]]; then
  # Rolled back from this release already; a newer server-live, or deleting the file, retries.
  log "release $want failed before; staying on $have"
  ping_heartbeat /fail
  exit 1
fi
log "server-live is $want; running ${have}"

# 2. Download and unpack, once per release.
mkdir -p "$APP_ROOT/releases" "$STATE_DIR/backups"
release_dir="$APP_ROOT/releases/$want"
if [[ ! -f "$release_dir/release.json" ]]; then
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  base="$DOWNLOAD_BASE/$tag"
  curl -fsSL -m 600 --retry 3 -o "$work/$tag.tar.gz" "$base/$tag.tar.gz"
  curl -fsSL -m 60 --retry 3 -o "$work/$tag.tar.gz.sha256" "$base/$tag.tar.gz.sha256"
  (cd "$work" && sha256sum -c "$tag.tar.gz.sha256")
  tar -xzf "$work/$tag.tar.gz" -C "$work"
  grep -q "\"commit\":\"$want\"" "$work/$tag/release.json" || {
    log "the archive's release.json does not name $want"
    exit 1
  }
  chown -R root:root "$work/$tag"
  chmod -R go-w,a+rX "$work/$tag"
  rm -rf "$release_dir"
  mv "$work/$tag" "$release_dir"
  log "unpacked $tag"
fi

# 3. Let the games in progress finish.
deadline=$(($(date +%s) + WAIT_MINUTES * 60))
while true; do
  active="$(health | health_field activeGames || true)"
  if [[ -z "$active" || "$active" == "0" ]]; then break; fi
  if (($(date +%s) >= deadline)); then
    log "games still running after $WAIT_MINUTES minutes; deploying anyway"
    break
  fi
  log "waiting for $active game(s) to end"
  sleep 30
done

# 4. Back up, switch, start.
db="$(env_value TABLE_DB_PATH)"
db="${db:-$STATE_DIR/tables.sqlite}"
previous="$(readlink "$APP_ROOT/current" 2>/dev/null || true)"
unit stop
backup=""
if [[ -f "$db" ]]; then
  backup="$STATE_DIR/backups/tables-$(date -u +%Y%m%dT%H%M%SZ)-${have:0:12}.sqlite"
  # The server is stopped, so the database and its journal files are consistent on disk.
  for suffix in "" -wal -shm; do
    if [[ -f "$db$suffix" ]]; then cp -p "$db$suffix" "$backup$suffix"; fi
  done
  log "database backed up to $backup"
fi
switch_to() {
  ln -sfn "$1" "$APP_ROOT/current.next"
  mv -T "$APP_ROOT/current.next" "$APP_ROOT/current"
}
switch_to "$release_dir"
unit start

# 5. Confirm, or roll back.
came_up() {
  local until=$(($(date +%s) + START_SECONDS))
  while (($(date +%s) < until)); do
    if [[ "$(health | health_field version || true)" == "$1" ]]; then return 0; fi
    sleep 5
  done
  return 1
}
if came_up "$want"; then
  log "release $want is live"
  ping_heartbeat
  # Keep the newest few releases and backups; the running one is never removed.
  ls -1t "$APP_ROOT/releases" | tail -n +$((KEEP_RELEASES + 1)) | while read -r old; do
    [[ "$APP_ROOT/releases/$old" == "$release_dir" ]] || rm -rf "${APP_ROOT:?}/releases/$old"
  done
  { ls -1t "$STATE_DIR/backups" | grep -E '\.sqlite$' || true; } | tail -n +$((KEEP_BACKUPS + 1)) |
    while read -r old; do rm -f "$STATE_DIR/backups/$old" "$STATE_DIR/backups/$old"-wal "$STATE_DIR/backups/$old"-shm; done
  exit 0
fi

log "release $want did not answer /health in ${START_SECONDS}s; rolling back"
journalctl -u "$SERVICE" -n 40 --no-pager || true
unit stop
if [[ -n "$backup" ]]; then
  for suffix in "" -wal -shm; do
    rm -f "$db$suffix"
    if [[ -f "$backup$suffix" ]]; then cp -p "$backup$suffix" "$db$suffix"; fi
  done
fi
if [[ -n "$previous" ]]; then
  switch_to "$previous"
  unit start
  came_up "$have" && log "rolled back to $have" || log "the old release $have did not come back either"
fi
# Remember the failure so the next tick does not retry the same broken release every 3 minutes.
echo "$want" > "$STATE_DIR/failed-release"
ping_heartbeat /fail
exit 1
