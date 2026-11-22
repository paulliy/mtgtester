# Hosting a table

How to run `serve:table` so friends can play from their own browsers
([ADR 0031](../decisions/0031-multiplayer-tables.md)). Tables are for people who know each other;
there are no accounts and no public matchmaking.

**Never expose `serve`.** The tester's server has no authentication, sends every hand and the
seed to anyone connected, and runs debug and analysis endpoints. Only `serve:table` is built to be
reached from another machine.

`serve:table` needs Bun 1.4.3 or later and refuses to start on an older one: Bun 1.3's
`server.stop()` never settles once a table socket has closed, so shutdown would hang.

The table page's Content Security Policy runs only the bundle's own scripts. Players' browsers
fetch card images from `cards.scryfall.io` and token art from `api.scryfall.com` themselves, so
Scryfall sees each player's address; on a network with no internet access the board shows the
cards' placeholder faces instead.

## Modes

| Mode        | Command                                       | For                                         |
| ----------- | --------------------------------------------- | ------------------------------------------- |
| Development | `bun run serve:table --dev`                   | Your own machine only (loopback)            |
| LAN         | `bun run serve:table --insecure-lan`          | Players on your own network, no TLS         |
| TLS         | `bun run serve:table` with a certificate      | Players anywhere, the server terminates TLS |
| TLS proxy   | `bun run serve:table` behind nginx, Caddy ... | Players anywhere, the proxy terminates TLS  |

Outside `--dev`, the server refuses to start without all three of these, whatever address it
binds (a tunnel or proxy can expose a loopback bind):

- `TABLE_PUBLIC_ORIGIN`: where invite links point, such as `https://tables.example.com`;
- `TABLE_ALLOWED_ORIGINS`: comma-separated origins a page or socket may come from (it must
  include the public origin);
- `TABLE_ALLOWED_HOSTS`: comma-separated `host` or `host:port` values a request may name.

It also refuses to start without TLS unless `--insecure-lan` is passed. Development-only settings
(`TABLE_TEST_RNG_KEY`, `TABLE_TURN_CAP`, `TABLE_PACE_MS`, `TABLE_CLOCK_SCALE`, `TABLE_HOST_SECRET`, `TABLE_MAX_STEP_WORK`, `TABLE_CLOCK=off`)
are refused outside `--dev`.

## LAN game

```bash
TABLE_HOST=0.0.0.0 \
TABLE_PUBLIC_ORIGIN=http://192.168.1.20:3002 \
TABLE_ALLOWED_ORIGINS=http://192.168.1.20:3002 \
TABLE_ALLOWED_HOSTS=192.168.1.20:3002 \
bun run serve:table --insecure-lan
```

- Use your machine's LAN address. Only peers in private ranges (10/8, 172.16/12, 192.168/16, IPv6
  unique-local and link-local) are accepted.
- A connection from your own machine is accepted only with a loopback `Host` (`localhost:3002`
  added to `TABLE_ALLOWED_HOSTS`), so a tunnel running on your machine cannot relay outsiders in.
- Traffic, seat tokens included, is unencrypted. Every player sees a banner saying so. Anyone on
  the network who can read it could take a seat. Use a network you trust.

## TLS on the server

```bash
TABLE_HOST=0.0.0.0 TABLE_PORT=443 \
TABLE_TLS_CERT=/etc/tables/fullchain.pem TABLE_TLS_KEY=/etc/tables/privkey.pem \
TABLE_PUBLIC_ORIGIN=https://tables.example.com \
TABLE_ALLOWED_ORIGINS=https://tables.example.com \
TABLE_ALLOWED_HOSTS=tables.example.com \
bun run serve:table
```

## Behind a TLS proxy

Bind the table server to loopback and let the proxy terminate TLS:

```bash
TABLE_HOST=127.0.0.1 TABLE_PORT=3002 \
TABLE_BEHIND_TLS_PROXY=1 TABLE_TRUSTED_PROXY=127.0.0.1 \
TABLE_PUBLIC_ORIGIN=https://tables.example.com \
TABLE_ALLOWED_ORIGINS=https://tables.example.com \
TABLE_ALLOWED_HOSTS=tables.example.com \
bun run serve:table
```

The proxy must:

- pass `Host` through and **append** the client's address to `X-Forwarded-For` (nginx:
  `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`);
- upgrade `/tables/<id>/ws` to a WebSocket (nginx: `proxy_http_version 1.1;` with the
  `Upgrade` and `Connection` headers);
- be the only thing that can reach the table server's port.

Only `TABLE_TRUSTED_PROXY` may connect. The client is the rightmost `X-Forwarded-For` entry, the
one the proxy added; entries to its left came from the client and are ignored. Throttles and
per-address caps key on that client address.

## Tunnels

A tunnel (Cloudflare Tunnel, ngrok, Tailscale Funnel) is a TLS proxy you do not run. Treat it as
one: put its public hostname in the allowlists and `TABLE_PUBLIC_ORIGIN`, and its local connector
address in `TABLE_TRUSTED_PROXY` with `TABLE_BEHIND_TLS_PROXY=1`. Without that the server refuses
to start, and in LAN mode it refuses a loopback peer that names a public host.

A worked example, an Oracle Cloud VM behind a Cloudflare Tunnel with a systemd service, is
[deploying on Oracle Cloud](deploy-oracle-cloud.md).

## What the host sees and can do

- The host secret, printed at startup, creates tables. The host token, returned once per table,
  approves seat requests, sets bots, kicks, starts and abandons.
- The host approves each seat request by its claim and short verification code; nobody takes a
  seat without approval, the host included.
- The host cannot read another seat's hand, choose for another seat, or get another seat's token
  reissued during a game. The host can end the game.
- Each game's RNG key, every decklist and a turn-by-turn replay unlock for every player when the
  game ends.
- The table database (`TABLE_DB_PATH`, outside the served directory) holds the approved decklists,
  each start attempt's private manifest with its key, and the game log.

## Trust assumptions

The full list is in ADR 0031 ("Trust assumptions and accepted risks"). In short: players know
each other; the host runs the server and could read its memory and database; a player can see
how long another takes to decide; and on `--insecure-lan` the network is trusted.

## Limits

- A 256 KiB socket frame; a 64 KiB, 250-line decklist.
- A socket must join, resume a seat or authenticate as host within 10 seconds, and send at most
  20 frames a second.
- Per client address: 8 open sockets and 30 opens a minute; two pending seat requests.
- A seat may be taken over by a new connection at most six times a minute.
- Idle sockets close after two minutes without traffic (the server pings), and a socket that falls
  1 MiB behind on outbound frames is closed.
- Failed secrets and tokens are throttled per address with a growing delay, not a lockout.
