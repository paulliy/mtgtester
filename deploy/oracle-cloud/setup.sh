#!/usr/bin/env bash
# One-time setup of the table server on a fresh Ubuntu VM (Oracle Cloud Ampere A1, arm64, or any
# x86-64 or arm64 Ubuntu 22.04/24.04). Run as the default `ubuntu` user:
#
#   curl -fsSL https://raw.githubusercontent.com/paulliy/mtgtester/main/deploy/oracle-cloud/setup.sh -o setup.sh
#   less setup.sh            # read it first
#   bash setup.sh
#
# It creates an `mtg` user, installs Bun for it, clones the repository to /opt/mtgtester, builds
# the table web bundle and the prebuilt card file, and installs (but does not start) the systemd
# service. It is safe to run again. The guide is docs/guides/deploy-oracle-cloud.md.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/paulliy/mtgtester.git}"
BRANCH="${BRANCH:-main}"
BUN_VERSION="${BUN_VERSION:-bun-v1.4.4}"
APP_DIR=/opt/mtgtester

echo "==> Installing system packages"
sudo apt-get update -y
sudo apt-get install -y git curl unzip ca-certificates

echo "==> Creating the mtg user"
if ! id mtg >/dev/null 2>&1; then
  sudo useradd --system --create-home --shell /bin/bash mtg
fi

echo "==> Installing Bun ${BUN_VERSION} for mtg"
sudo -u mtg -H bash -c "curl -fsSL https://bun.sh/install | bash -s '${BUN_VERSION}'"
BUN=/home/mtg/.bun/bin/bun
sudo -u mtg -H "$BUN" --version

echo "==> Fetching the repository into ${APP_DIR}"
if [ ! -d "${APP_DIR}/.git" ]; then
  sudo mkdir -p "${APP_DIR}"
  sudo chown mtg:mtg "${APP_DIR}"
  sudo -u mtg -H git clone --branch "${BRANCH}" "${REPO_URL}" "${APP_DIR}"
else
  sudo -u mtg -H git -C "${APP_DIR}" fetch origin "${BRANCH}"
  sudo -u mtg -H git -C "${APP_DIR}" checkout "${BRANCH}"
  sudo -u mtg -H git -C "${APP_DIR}" merge --ff-only "origin/${BRANCH}"
fi

run() { sudo -u mtg -H bash -c "cd ${APP_DIR} && $*"; }

echo "==> Installing dependencies"
run "$BUN install --frozen-lockfile"

echo "==> Building the table web bundle"
run "$BUN run --cwd apps/web build:table"

echo "==> Downloading Scryfall card data and building the prebuilt card file"
if [ ! -f "${APP_DIR}/data/scryfall-oracle-cards.json" ]; then
  run "$BUN run scryfall:update"
fi
run "$BUN run table:cards"
run "mkdir -p data/tables"

echo "==> Installing the settings file and the service"
if [ ! -f /etc/mtg-table.env ]; then
  sudo install -m 640 -o root -g mtg "${APP_DIR}/deploy/oracle-cloud/mtg-table.env.example" /etc/mtg-table.env
  echo "    Created /etc/mtg-table.env. Edit it: put your subdomain in the three TABLE_ settings."
fi
sudo install -m 644 "${APP_DIR}/deploy/oracle-cloud/mtg-table.service" /etc/systemd/system/mtg-table.service
sudo systemctl daemon-reload
sudo systemctl enable mtg-table

cat <<'DONE'

Setup finished. Next:
  1. sudo nano /etc/mtg-table.env          # replace tables.example.com with your subdomain
  2. sudo systemctl start mtg-table
  3. sudo journalctl -u mtg-table -n 40    # the host secret is printed here
  4. Install the Cloudflare Tunnel connector (guide, step 5).
DONE
