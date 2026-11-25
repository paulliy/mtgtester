# Deploying tables on Oracle Cloud behind a Cloudflare subdomain

How to run `serve:table` on an Oracle Cloud Always Free VM and publish it at a subdomain of a site
whose DNS is on Cloudflare, such as `tables.example.com`, through a Cloudflare Tunnel. The VM opens
no inbound ports apart from SSH: `cloudflared` on the VM dials out to Cloudflare, and Cloudflare
terminates TLS. This is the tunnel mode of [table hosting](table-hosting.md); read its exposure
rules and limits first.

What runs where:

- **Cloudflare:** DNS for the subdomain, TLS, and the tunnel's public hostname.
- **GitHub:** builds each server release from main (`.github/workflows/deploy.yml`) and moves the
  `server-live` tag to it. Nothing is built on the VM.
- **VM:** `cloudflared`, the table server (`mtg-table.service`) bound to `127.0.0.1:3002` and
  running the release `/opt/mtgtester-releases/current` points at, its SQLite database in
  `/var/lib/mtgtester/`, and the deploy agent (`mtg-deploy.timer`) that switches releases.

A release carries the whole public site (ADR 0053), built with `vite build --mode site`
(`apps/web/dist-site`) next to the site's card files (`data/site-cards`). When both are present and
`TABLE_WEB_DIR` is unset, the server serves the site: single player runs in the visitor's browser,
the tables live under `/multiplayer`, and `/cards/` holds the card files. Without them it serves
the tables-only app, as before.

The files are in [`deploy/oracle-cloud/`](../../deploy/oracle-cloud/).

## 1. Create the Oracle Cloud account (you)

1. Sign up at [oracle.com/cloud/free](https://www.oracle.com/cloud/free/). It asks for a card for
   identity checks. Always Free resources are not charged.
2. Choose your **home region** carefully: Always Free Ampere capacity exists only there and it
   cannot be changed later. A less busy region makes step 2 easier.
3. Optional, recommended: upgrade the account to **Pay As You Go**. Always Free resources stay
   free, but Oracle stops reclaiming idle Always Free VMs, and "out of capacity" errors become
   rarer. Set a budget alert at $1 under Billing so any accidental paid resource is visible.

## 2. Create the VM (you)

Compute, Instances, Create instance:

- **Image:** Canonical Ubuntu 24.04 (or 22.04).
- **Shape:** Ampere, `VM.Standard.A1.Flex`, **2 OCPU and 12 GB** memory. That is the whole
  Always Free Ampere allowance as Oracle documents it in 2026 (2 OCPU and 12 GB in total, split
  across up to two instances); the older 4 OCPU and 24 GB allowance no longer applies. Check the
  current figures on Oracle's Always Free page before creating the VM. The server needs about
  400 MB before any game starts, and each game runs in its own worker on top of that, so 1 OCPU and 6 GB
  should also be enough for the default 8 tables.
- **Networking:** a new VCN with a public subnet and a public IPv4 address, so you can SSH in.
  Leave the security list with SSH (22) only. Do not open 3002, 80 or 443: the tunnel needs no
  inbound port.
- **SSH key:** upload your public key or download the generated one.
- **Boot volume:** the default 47 GB is enough (the Always Free allowance is 200 GB in total).

If creation fails with "Out of host capacity", try another availability domain, try again later,
or try 1 OCPU and 6 GB.

Then connect: `ssh ubuntu@<public-ip>`.

### If no Ampere capacity is available: the AMD micro

`VM.Standard.E2.1.Micro` (under "Specialty and previous generation", also Always Free) has 1 GB
of memory and a small share of one CPU (it can burst briefly). It is enough for a couple of tables,
with these differences:

- Pick Ubuntu 24.04 for x86-64 (the micro is not ARM). Everything else in this guide is the same.
- `setup.sh` detects the small VM, adds a 4 GB swap file, and sets `TABLE_MAX_TABLES=2`.
- Engine steps run several times slower than on Ampere. Ordinary turns stay quick, but a big
  board can pause noticeably. This shape has not been tried with a full game yet.
- Releases are built for x86-64. Moving to Ampere (arm64) needs an arm64 build in `deploy.yml`
  first; then create the new VM, run `setup.sh` there, copy `/var/lib/mtgtester/tables.sqlite`
  across, and point the tunnel at it.

## 3. Install the table server (script)

On the VM, as `ubuntu`:

```bash
curl -fsSL https://raw.githubusercontent.com/paulliy/mtgtester/main/deploy/oracle-cloud/setup.sh -o setup.sh
less setup.sh   # read it before running it
bash setup.sh
```

[`setup.sh`](../../deploy/oracle-cloud/setup.sh) installs Bun, creates an `mtg` system user,
installs the settings files (`/etc/mtg-table.env`, `/etc/mtg-deploy.env`), caps the journal at
100 MB, and installs and enables `mtg-table.service` and the deploy agent (`mtg-deploy.timer`). Once
`/etc/mtg-table.env` names your subdomain it runs the agent, which downloads the live release and
starts the server. Run it again after editing the file (step 4).

## 4. Configure and start (you)

```bash
sudo nano /etc/mtg-table.env
```

Replace `tables.example.com` with your subdomain in `TABLE_PUBLIC_ORIGIN`,
`TABLE_ALLOWED_ORIGINS` (both with `https://`) and `TABLE_ALLOWED_HOSTS` (no scheme). Leave
`TABLE_HOST=127.0.0.1`, `TABLE_BEHIND_TLS_PROXY=1` and `TABLE_TRUSTED_PROXY=127.0.0.1` as they are.
The file is documented line by line ([`mtg-table.env.example`](../../deploy/oracle-cloud/mtg-table.env.example)).

```bash
sudo systemctl start mtg-deploy.service    # downloads the live release and starts the server
sudo journalctl -u mtg-table -n 40 --no-pager
```

The log should say `production, behind a TLS proxy` and print the **host secret**, which creates
tables. A new secret is printed at every start; read it from the log again after a restart. To keep one
fixed secret instead, set `TABLE_HOST_SECRET` in `/etc/mtg-table.env` (see the comment there) and
restart. Keep it private.

## 5. Create the Cloudflare Tunnel (you)

In the Cloudflare dashboard: Zero Trust, Networks, Tunnels, Create a tunnel.

1. Type **Cloudflared**, name it (for example `mtg-tables`).
2. Environment **Debian**, architecture **arm64** on the Ampere A1, or **64-bit** (amd64) on the
   AMD micro (`uname -m` prints `aarch64` or `x86_64`). The dashboard shows install commands with a
   token. Run them on the VM. They install `cloudflared` as a system service that starts at boot.
3. **Public hostname:** subdomain `tables`, domain your site, path empty.
   **Service:** type `HTTP`, URL `127.0.0.1:3002`. Use `127.0.0.1`, not `localhost`: the server
   trusts only the IPv4 loopback address, and `localhost` can resolve to IPv6 `::1`.
4. Save. Cloudflare creates the DNS record for the subdomain itself. If the subdomain already has a
   DNS record, delete it first.

WebSockets need no extra setting; Cloudflare passes them through tunnels by default. Leave the
hostname's "HTTP Host Header" override empty, so the server sees your subdomain in `Host`.

Prefer the command line? The equivalent locally managed tunnel is `cloudflared tunnel login`,
`cloudflared tunnel create mtg-tables`, `cloudflared tunnel route dns mtg-tables tables.example.com`,
and a `/etc/cloudflared/config.yml` of:

```yaml
tunnel: mtg-tables
credentials-file: /etc/cloudflared/<tunnel-id>.json
ingress:
  - hostname: tables.example.com
    service: http://127.0.0.1:3002
  - service: http_status:404
```

then `sudo cloudflared service install`.

## 6. Check it works

- `https://tables.<your-site>/` loads the table lobby.
- Create a table from your own machine:

  ```bash
  curl -s -X POST -H "Authorization: Bearer <host secret>" https://tables.<your-site>/tables
  ```

  It returns the host token and an invite link. Open the link, and have a friend open it from
  another network.

- A request naming another host is refused with 403, and the VM's public IP on port 3002 does not
  answer at all.

Player addresses: Cloudflare puts the visitor's address last in `X-Forwarded-For`, which is the
entry the server's throttles and per-address caps use. Players behind one shared address (one
household) share those caps: 8 sockets and 30 socket opens a minute.

## Releases and updates

Merging to main updates the server on its own:

1. [`deploy.yml`](../../.github/workflows/deploy.yml) builds the release on GitHub: production
   dependencies, the table web bundle, and the prebuilt card file from the pinned Scryfall bank
   (the `SCRYFALL_BULK_URL` and `SCRYFALL_BULK_SHA256` repository variables). It publishes it as the
   GitHub release `server-<commit>` and moves the `server-live` tag to the commit. The second job
   runs in the `production` environment, so a required reviewer can be added in the repository's
   settings.
2. Every three minutes the deploy agent ([`deploy-agent.sh`](../../deploy/oracle-cloud/deploy-agent.sh))
   reads the tag. For a new release it downloads `server-<commit>.tar.gz`, checks its SHA-256, and
   unpacks it into `/opt/mtgtester-releases/releases/<commit>`.
3. It waits for games in progress to end (`activeGames` on `/health`), for up to an hour.
4. It stops the server, copies the database to `/var/lib/mtgtester/backups/`, points `current` at
   the new release, and starts the server.
5. It waits up to five minutes for `/health` to name the new commit. If it never does, it restores
   the database copy, points `current` back, starts the old release, and records the commit in
   `/var/lib/mtgtester/failed-release` so it is not retried. A newer release, or deleting that
   file, tries again.

`/health` answers `{ ok, version, protocol, activeGames }`, where `version` is the release's commit
(`dev` outside a release).

Watching it:

```bash
systemctl list-timers mtg-deploy.timer
sudo journalctl -u mtg-deploy -n 60 --no-pager
readlink /opt/mtgtester-releases/current
```

To go back to an older release, move the tag on your own machine
(`git tag -f server-live <commit> && git push -f origin refs/tags/server-live`); the agent switches
within three minutes. The last three releases stay on disk and the last ten database copies in
`backups/`.

Alerts: put a [healthchecks.io](https://healthchecks.io) check's ping URL in `/etc/mtg-deploy.env`
(`HEARTBEAT_URL`, period 10 minutes). The agent pings it after each run that finds the right release
answering, and pings `/fail` after a rollback. Add an uptime check (UptimeRobot or Better Stack) on
`https://tables.<your-site>/health` for the public side.

### Moving an existing VM to releases

A VM set up with the old `setup.sh` runs a git checkout at `/opt/mtgtester`. To move it:

1. Make sure the first `Deploy` run on main has finished (the `server-live` tag exists).
2. Run the new `setup.sh` as in step 3. It copies the database from
   `/opt/mtgtester/data/tables/tables.sqlite` to `/var/lib/mtgtester/`, comments out any
   `TABLE_DB_PATH` in `/etc/mtg-table.env`, replaces `mtg-table.service`, and starts the live
   release.
3. Check `https://tables.<your-site>/health` names the commit, then play a game.
4. Delete the old checkout when you no longer need it: `sudo rm -rf /opt/mtgtester`.

## Backups

The only state is the table database, `/var/lib/mtgtester/tables.sqlite` (decklists, game
logs, replays). The deploy agent copies it before every release switch. To copy it yourself, do it
while the service is stopped, or with
`sqlite3 tables.sqlite ".backup /path/backup.sqlite"` while it runs (`sudo apt-get install sqlite3`).

## Memory

With the prebuilt card file, the server reads about 24 MB of converted cards at startup instead of
parsing the ~200 MB Scryfall file. On a synthetic Scryfall-shaped bank of 172 MB (the real file is
not available in CI), peak startup memory fell from about 1.5 GB to about 480 MB, and resident
memory after start from about 680 MB to about 370 MB. The synthetic bank's supported pool is larger
than the real one, so real figures should be lower. Each running game adds its own worker on top.

`mtg-table.service` sets `MemoryHigh=700M`, which makes the kernel reclaim from the server before
the VM runs short, and `MemorySwapMax=1500M`, which stops it from thrashing the whole VM through
swap.
