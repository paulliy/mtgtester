# Hosting tables from your own computer behind a Cloudflare subdomain

The free way to put `serve:table` on a subdomain such as `tables.example.com` when no cloud VM is
available: the server and `cloudflared` run on your own Windows computer, and Cloudflare carries
players' connections to it through a tunnel. Your router needs no port forwarding and your home
address is not published. The subdomain is up only while the computer is on and the server is
running. This is the tunnel mode of [table hosting](table-hosting.md); a Linux VM is
[deploying on Oracle Cloud](deploy-oracle-cloud.md), and moving there later needs only the table
database copied across.

## 1. Install the tools

In PowerShell:

```powershell
winget install --id Git.Git -e
powershell -c "irm bun.sh/install.ps1 | iex"
```

Close and reopen PowerShell so `git` and `bun` are on the path, then check `bun --version`
(1.4.3 or later).

## 2. Get the project and build it

```powershell
cd $HOME
git clone https://github.com/paulliy/mtgtester.git
cd mtgtester
git checkout claude/project-thread-0igrlc   # until the deployment PR is merged
bun install
bun run --cwd apps/web build:table
bun run scryfall:update
bun run table:cards
```

`scryfall:update` downloads about 200 MB of card data; `table:cards` converts it to the small file
the server reads.

## 3. Start the server

```powershell
.\deploy\home\start-table.ps1 -Subdomain tables.example.com
```

Use your own subdomain. If PowerShell refuses to run scripts, run
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once. The window shows
`production, behind a TLS proxy` and the **host secret**, which creates tables. Leave the window
open: closing it stops the server. A new secret is printed at every start.

## 4. Create the Cloudflare Tunnel

In the Cloudflare dashboard: Zero Trust, Networks, Tunnels, Create a tunnel.

1. Type **Cloudflared**, name it (for example `mtg-tables`).
2. Environment **Windows**, architecture **64-bit**. Download and run the installer it links, then
   run the command it shows (with the token) in an **administrator** PowerShell. That installs
   `cloudflared` as a Windows service that starts with the computer.
3. **Public hostname:** subdomain `tables`, your domain, path empty. **Service:** type `HTTP`, URL
   `127.0.0.1:3002`. Use `127.0.0.1`, not `localhost`.
4. Save. Cloudflare creates the DNS record itself; delete any existing record for that subdomain
   first.

## 5. Check it works

- `https://tables.example.com/` loads the table lobby, also from a phone on mobile data.
- Create a table:

  ```powershell
  curl.exe -s -X POST -H "Authorization: Bearer <host secret>" https://tables.example.com/tables
  ```

  It returns the host token and an invite link to share.

## Day to day

- Start: open PowerShell in `mtgtester` and run the script from step 3. The tunnel service is
  already running.
- Stop: Ctrl+C in that window. Games in progress end.
- Update: `git pull`, `bun install`, `bun run --cwd apps/web build:table`, then start again.
- Sleep: Windows sleep stops everything. While hosting, set Power Options so the computer does not
  sleep when plugged in.
- Data: the table database is `data\tables\tables.sqlite` in the project folder.
