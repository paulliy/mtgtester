#!/usr/bin/env bash
# Set up, or move to, the release layout for the table server on an Ubuntu VM (Oracle Cloud Ampere
# A1 arm64, the Always Free AMD micro, or any x86-64 or arm64 Ubuntu 22.04/24.04). Run it as the
# default `ubuntu` user:
#
#   curl -fsSL https://raw.githubusercontent.com/paulliy/mtgtester/main/deploy/oracle-cloud/setup.sh -o setup.sh
#   less setup.sh            # read it first
#   bash setup.sh
#
# Nothing is built on the VM. GitHub builds each release (.github/workflows/deploy.yml), and the
# deploy agent (mtg-deploy.timer) downloads the one the server-live tag names into
# /opt/mtgtester-releases and switches to it. This script creates the `mtg` user, installs Bun, the
# units and the settings files, moves an existing database from the old checkout at /opt/mtgtester
# to /var/lib/mtgtester, and runs the agent once. It is safe to run again.
#
# Releases are built for x86-64 (the GitHub runner). An arm64 VM needs an arm64 runner in
# deploy.yml first. The guide is docs/guides/deploy-oracle-cloud.md.
set -euo pipefail

REPO="${REPO:-paulliy/mtgtester}"
BRANCH="${BRANCH:-main}"
BUN_VERSION="${BUN_VERSION:-bun-v1.4.4}"
RAW="https://raw.githubusercontent.com/${REPO}/${BRANCH}/deploy/oracle-cloud"
OLD_CHECKOUT=/opt/mtgtester
APP_ROOT=/opt/mtgtester-releases
STATE_DIR=/var/lib/mtgtester

if [ "$(uname -m)" != "x86_64" ]; then
  echo "Releases are built for x86-64; this VM is $(uname -m). See the comment at the top." >&2
  exit 1
fi

echo "==> Installing system packages"
sudo apt-get update -y
sudo apt-get install -y curl unzip ca-certificates

# The 1 GB Always Free AMD micro needs swap to carry a game through a memory spike.
MEM_KB=$(awk '/MemTotal/{print $2}' /proc/meminfo)
SMALL_VM=0
if [ "${MEM_KB}" -lt 3000000 ]; then
  SMALL_VM=1
  if ! swapon --show | grep -q .; then
    echo "==> Small VM (${MEM_KB} kB): adding a 4 GB swap file"
    sudo install -m 600 /dev/null /swapfile
    sudo fallocate -l 4G /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  fi
  # Use swap only under real pressure, so a live game stays in memory.
  echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/90-mtg-swappiness.conf >/dev/null
  sudo sysctl -q -p /etc/sysctl.d/90-mtg-swappiness.conf
fi

echo "==> Creating the mtg user"
if ! id mtg >/dev/null 2>&1; then
  sudo useradd --system --create-home --shell /usr/sbin/nologin mtg
fi

echo "==> Installing Bun ${BUN_VERSION} for mtg"
if [ "$(sudo -u mtg -H /home/mtg/.bun/bin/bun --version 2>/dev/null || true)" != "${BUN_VERSION#bun-v}" ]; then
  sudo -u mtg -H bash -c "curl -fsSL https://bun.sh/install | bash -s '${BUN_VERSION}'"
fi
sudo -u mtg -H /home/mtg/.bun/bin/bun --version

echo "==> Fetching the deploy files from ${REPO}@${BRANCH}"
FILES=$(mktemp -d)
trap 'rm -rf "$FILES"' EXIT
for file in mtg-table.service mtg-table.env.example mtg-deploy.service mtg-deploy.timer \
  mtg-deploy.env.example deploy-agent.sh journald-mtg.conf; do
  curl -fsSL "${RAW}/${file}" -o "${FILES}/${file}"
done

echo "==> Installing the settings files"
if [ ! -f /etc/mtg-table.env ]; then
  # systemd reads it as root, so the service account never needs to read the secret file.
  sudo install -m 600 -o root -g root "${FILES}/mtg-table.env.example" /etc/mtg-table.env
  if [ "${SMALL_VM}" = 1 ]; then
    # Each game runs in its own worker, so keep the number of games small on a 1 GB VM.
    sudo sed -i 's/^# TABLE_MAX_TABLES=8$/TABLE_MAX_TABLES=2/' /etc/mtg-table.env
  fi
  echo "    Created /etc/mtg-table.env. Edit it: put your subdomain in the three TABLE_ settings."
fi
# The old layout kept the database under the checkout; the service may now write only here.
if sudo grep -q '^TABLE_DB_PATH=' /etc/mtg-table.env; then
  sudo sed -i 's|^TABLE_DB_PATH=|# Moved to /var/lib/mtgtester by setup.sh: TABLE_DB_PATH=|' /etc/mtg-table.env
fi
if [ ! -f /etc/mtg-deploy.env ]; then
  sudo install -m 600 -o root -g root "${FILES}/mtg-deploy.env.example" /etc/mtg-deploy.env
fi

echo "==> Capping the journal at 100 MB"
sudo install -d /etc/systemd/journald.conf.d
sudo install -m 644 "${FILES}/journald-mtg.conf" /etc/systemd/journald.conf.d/90-mtg.conf
sudo systemctl restart systemd-journald

echo "==> Moving the database to ${STATE_DIR}"
sudo install -d -m 700 -o mtg -g mtg "${STATE_DIR}"
OLD_DB="${OLD_CHECKOUT}/data/tables/tables.sqlite"
if [ -f "${OLD_DB}" ] && [ ! -f "${STATE_DIR}/tables.sqlite" ]; then
  sudo systemctl stop mtg-table || true
  for suffix in "" -wal -shm; do
    if [ -f "${OLD_DB}${suffix}" ]; then
      sudo cp -p "${OLD_DB}${suffix}" "${STATE_DIR}/tables.sqlite${suffix}"
    fi
  done
  sudo chown mtg:mtg "${STATE_DIR}"/tables.sqlite*
  echo "    Copied ${OLD_DB}. The old copy stays where it was until you delete the checkout."
fi

echo "==> Installing the deploy agent and the units"
sudo install -d -m 755 "${APP_ROOT}" "${APP_ROOT}/releases" /usr/local/lib/mtgtester
sudo install -m 755 "${FILES}/deploy-agent.sh" /usr/local/lib/mtgtester/deploy-agent.sh
for unit in mtg-table.service mtg-deploy.service mtg-deploy.timer; do
  sudo install -m 644 "${FILES}/${unit}" "/etc/systemd/system/${unit}"
done
sudo systemctl daemon-reload
sudo systemctl enable mtg-table mtg-deploy.timer

echo "==> Fetching and starting the live release"
if sudo grep -q 'tables.example.com' /etc/mtg-table.env; then
  echo "    /etc/mtg-table.env still names tables.example.com: edit it, then run"
  echo "    sudo systemctl start mtg-deploy.service"
else
  sudo systemctl start mtg-deploy.service || {
    echo "    The deploy agent failed: sudo journalctl -u mtg-deploy -n 60" >&2
    exit 1
  }
  sudo systemctl start mtg-deploy.timer
  curl -fsS -H "Host: $(sudo sed -n 's/^TABLE_ALLOWED_HOSTS=//p' /etc/mtg-table.env | cut -d, -f1)" \
    -H 'X-Forwarded-For: 127.0.0.1' "http://127.0.0.1:$(sudo sed -n 's/^TABLE_PORT=//p' /etc/mtg-table.env)/health"
  echo
fi

cat <<'DONE'

Setup finished. Next, if you have not already:
  1. sudo nano /etc/mtg-table.env           # your subdomain in the three TABLE_ settings
  2. sudo nano /etc/mtg-deploy.env          # the healthchecks.io ping URL
  3. sudo journalctl -u mtg-table -n 40     # the host secret, unless TABLE_HOST_SECRET is set
  4. Install the Cloudflare Tunnel connector (guide, step 5) if this is a new VM.
The old checkout at /opt/mtgtester is no longer used; delete it once the new layout has run a game.
DONE
