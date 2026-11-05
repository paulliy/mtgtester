# Table server security review

Date: 2026-10-29. Scope: `serve:table` and everything it reaches before a frame leaves the
process (`packages/server/src/table/`, `cli/serve-table.ts`, the table paths of
`match/session.ts`, `match/disclosure.ts`, `match/table-clocks.ts`, `db/tables.ts`,
`shared/src/table-protocol.ts`), as of the M5 commits on PR #44. Reviewed on the main thread
against [ADR 0031](../decisions/0031-multiplayer-tables.md) and plan M5 task 8.

**Result.** No unresolved high findings. Two medium findings were fixed in this change; the low
and accepted items are listed with their reasons.

## Checklist

| #   | Area          | Check                                                                                                                | Result                                                           |
| --- | ------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | Start-up      | Outside `--dev`: public origin, both allowlists, and TLS or `--insecure-lan`, on any bind                            | Pass (`config.test.ts`, `serve-table.test.ts`)                   |
| 2   | Start-up      | `--dev` refuses every proxy, TLS and allowlist setting and any non-loopback host or origin                           | Pass                                                             |
| 3   | Start-up      | Dev-only settings (fixed RNG key and host secret, turn cap, pace, clock scale, step work, clock off) outside `--dev` | Pass                                                             |
| 4   | Requests      | `Host` in the allowlist and any `Origin` in the allowlist, before routing, socket upgrades included                  | Pass (`exposure.test.ts`)                                        |
| 5   | Requests      | Behind a proxy: only the trusted proxy connects; the client is the rightmost `X-Forwarded-For` entry                 | Pass                                                             |
| 6   | Requests      | `--insecure-lan`: private-range peers only; a loopback peer naming a public host refused without a proxy             | Pass                                                             |
| 7   | Requests      | Request bodies capped before buffering                                                                               | Fixed here (finding M-2)                                         |
| 8   | Pages         | `frame-ancestors 'none'`, `nosniff`, `no-referrer`; only manifest files served; encoded `..` refused                 | Pass (`table-http.test.ts`)                                      |
| 9   | Pages         | Table database outside the served directory                                                                          | Pass (refused at start-up)                                       |
| 10  | Secrets       | Host secret, host tokens and seat tokens 256-bit, invite codes 128-bit, compared in constant time                    | Pass (`tokens.test.ts`)                                          |
| 11  | Secrets       | Failed secrets, invites and tokens throttled per address with a growing delay, not a lockout                         | Pass                                                             |
| 12  | Secrets       | Invite code only in the URL fragment and request bodies, never in a path or query                                    | Pass                                                             |
| 13  | Secrets       | Seat token never printed by the agent client; never reissued to the host mid-game                                    | Pass                                                             |
| 14  | Sockets       | 256 KiB frames; 10-second pre-authentication; 20 frames a second; idle timeout with pings; backpressure close        | Pass (`table-ws.test.ts`)                                        |
| 15  | Sockets       | Per-address caps on open sockets and opens a minute, with bounded memory                                             | Fixed here (finding M-1)                                         |
| 16  | Sockets       | Seat takeovers limited to six a minute; a superseded socket cannot act with a valid id and revision                  | Pass                                                             |
| 17  | Authority     | Seat taken from the socket binding, never from a payload; tester messages refused                                    | Pass                                                             |
| 18  | Authority     | Host-only messages need `hostAuth`; seats change only in `open`; no seat without approval                            | Pass (`table.test.ts`)                                           |
| 19  | Disclosure    | Every live frame scanned: key, seed, full state, debug, AI notes, raw halt text, engine ids, other hands, cues       | Pass (`frame-scan.ts` over real worker traffic, three scenarios) |
| 20  | Disclosure    | Full-state and post-game frames held by the outbound allowlist until the game is over                                | Pass                                                             |
| 21  | Disclosure    | Per-seat request ids, revisions and log sequences; boards only when the projection changed                           | Pass (`wire-ids.test.ts`)                                        |
| 22  | Randomness    | ChaCha20 key per attempt from the system CSPRNG; never in a frame, event or snapshot before the end                  | Pass (M2b tests, frame scan)                                     |
| 23  | Isolation     | One worker per game; a blocked worker is stopped after 30 s without a health answer; the table cap bounds workers    | Pass (`worker-port.test.ts`, hub health tests)                   |
| 24  | Isolation     | The bundled graph of `serve:table` and the worker reaches no batch, benchmark or Card Test Lab module                | Pass (`module-graph.test.ts`)                                    |
| 25  | Input parsing | Strict JSON (duplicate keys refused), closed message set, bounded strings, decklist size and line caps               | Pass (`table-protocol.test.ts`, `deck-check.test.ts`)            |
| 26  | Display names | 1–24 characters, control and bidirectional-override characters removed, lookalikes folded for uniqueness             | Pass (`tokens.test.ts`)                                          |
| 27  | Errors        | Refusals and interruptions are fixed sentences; no request text, stack or engine detail is echoed                    | Pass                                                             |

## Findings

### M-1 (medium, fixed): per-address socket counters grew without bound

`SocketLimiter` kept one entry for every client address it had seen and never removed it. A client
with an IPv6 block can present a new address per connection, so the map could grow until the
process ran out of memory. Fixed: idle addresses are forgotten once more than 10,000 are
remembered, least recently seen first; an address with a socket open is never forgotten, so its
concurrent cap still holds. Test: `exposure.test.ts`, "forgets idle addresses".

### M-2 (medium, fixed): request bodies were buffered before their size was checked

`readBody` read the whole body and then compared its length with 4 KiB. Bun's default body limit
is about 128 MB, so one request per connection could make the server buffer that much. Fixed:
`maxRequestBodySize` of 16 KiB on the server, so a larger body is refused before it is buffered.

### L-1 (low, accepted): table existence is observable

`GET /tables/<id>/ws` answers 404 for an unknown table and 426 for a known one without a
WebSocket upgrade. Table ids are random (at least 16 URL-safe characters from a CSPRNG), so this
does not make guessing feasible, and the id alone grants nothing: joining needs the invite code.

### L-2 (low, accepted): a player can time another's decisions

A seat's `clockState` starts when a decision is shown to another player and stops when it is
answered, so players see how long each person thinks. ADR 0031 decision 10 accepts this visible
wait. Decisions answered automatically (smart yield, quiet passes) start no clock and send no
frame.

### L-3 (low, accepted): the host can read the game

The host runs the process and can read its memory and the table database, which holds the key and
the approved decklists. ADR 0031's trust assumptions accept this: tables are for people who know
each other, and nobody else's machine holds anything.

### L-4 (low, accepted): `--insecure-lan` is unencrypted

On `--insecure-lan` anyone who can read the network can read seat tokens and take a seat. The mode
is opt-in, accepts private-range peers only, and every player sees a banner saying so
(`tableState.insecureLan`).

## Runs recorded

- `table-scripted-run.ts` (default): two scripted clients and two bots, dev mode, workers; scan
  clean over 135 frames.
- `--scenario disconnect`: four scripted clients at a scaled relaxed clock, one drops past its
  grace and rejoins; scan clean over 979 frames.
- `--scenario tls`: production mode behind a TLS proxy with a certificate made at run time, every
  client over https and wss; the scan uses the game's own key from the post-game record; clean
  over 174 frames.

## Open

- **A manual LAN game across two machines** with `--insecure-lan` is the M5 exit's last item. It
  needs two machines on one network and is owed by the owner; the scripted runs above cover the
  same code paths on loopback, and `exposure.test.ts` covers the LAN address rules. On
  2026-11-04 a game was played between two network namespaces on one machine, which separates
  the network stacks but not the machines ([follow-up](big-board-and-tables-2026-11-04.md)).
- **The web client (M6)** adds the table pages. Its bundle-manifest test keeps tester views out
  of the table build. The served bundle was reviewed on 2026-11-04
  ([follow-up](big-board-and-tables-2026-11-04.md)): its policy now runs only its own scripts.
