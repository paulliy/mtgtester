# The JSON agent client

`bun run agent-client` plays one Commander seat from a program instead of a browser. It is a
**client**, not a second way to run a game: it speaks the existing single-player WebSocket flow
against a running local server, and owns no engine, no rules, and no decision policy.

```powershell
bun run serve                                     # terminal 1
bun run agent-client --seat P1 --seed demo        # terminal 2, driven over stdin/stdout
```

Implementation: `packages/server/src/cli/agent-client.ts` (socket and process wiring) over
`packages/server/src/cli/agent-client-core.ts` (the whole translation, with its tests in
`agent-client-core.test.ts`).

## Interface

| Stream | Contents                                                                      |
| ------ | ----------------------------------------------------------------------------- |
| stdout | NDJSON — one JSON event object per line, nothing else, including for `--help` |
| stdin  | One JSON reply object per line, one per outstanding decision                  |
| stderr | Human diagnostics only                                                        |

Exit codes: `0` game over, `1` the run ended without one, `2` bad arguments, `130` interrupted.

### Options

```
--url <ws url>      WebSocket endpoint (default ws://127.0.0.1:3001/ws; loopback only)
--port <n>          Shorthand for ws://127.0.0.1:<n>/ws
--seat <P1..P4>     Seat the agent plays (default P1)
--seed <string>     Game seed (default: the server generates one)
--provider <kind>   Opponent decisions: random | ai (default random)
--pace-ms <n>       Bot presentation pace in ms (default 0 — no artificial delay)
```

The `startGame` message declares `capabilities: { rawActionData: true }` (ADR 0032 decision 7), so
each `LegalAction` in `decision-required` keeps its `data`, as documented below. The server sends
no `data` to a connection that does not ask, which is why the browser never sees it. This client
does not reconnect; a `resumeGame` it sent would have to declare the same capability again.

Four supported-pool seats, as `bun run pool` builds them. The URL must be loopback: the server
binds loopback only (brief §2), and this client will not be the thing that reaches past it.

## Events (stdout)

- `game-started` — `gameId`, `seed`, `providerKind`, `humanSeat`, `seats`, `startedAt`. The
  server's `sessionToken` is deliberately not republished: v1 does not reconnect.
- `decision-required` — `requestId`, `revision`, `request`, `state`, `ignoredAbilities`.
  `request` is the `DecisionRequest` verbatim; `request.legalActions` is the complete menu, and the
  only menu, the agent may choose from. `request.presentation` is the server's own wording for it
  (ADR 0032): `playerPrompt`, and for each action in the menu a `label`, `summary`, `costLabels`
  and so on. An agent may read it or ignore it; it never changes which actions are legal.
- `state-update` — `gameId`, `revision`, `connected`, `state`, `ignoredAbilities`. A new board with
  no decision attached.
- `error` — `source` (`agent` for a rejected reply, `server` otherwise), `fatal`, `message`,
  `deckIssues`/`unmodeledCards` when setup failed, and `requestId`/`revision` when the server
  correlated the error to a submission it rejected. Only a correlated rejection makes a decision
  answerable again; see below.
- `game-over` — `result`, `standings`, and the server's one-line `summary` ("Game over — winner P1 after 12 turns") when it sends one.

## Replies (stdin)

One line per `decision-required`:

```json
{
  "requestId": "g1-t3-d7",
  "revision": 12,
  "actionId": 4,
  "targets": [{ "slot": 0, "choice": "obj-42" }]
}
```

Exactly the fields `SubmitPlayerActionPayload` supports. Unknown reply fields and unknown fields
inside target choices are rejected rather than dropped. Target slots must be unique. A decision
requiring `manaSplit` or `combatDamageSplit` cannot be answered in v1 because
`submitPlayerAction` has nowhere on the wire to put the distribution. The client emits a fatal
error and ends the run without submitting an action for that decision.

A reply is rejected locally, without reaching the server, when it is not valid JSON, carries an
unsupported field, does not match the outstanding `requestId`/`revision`, names an `actionId` that
was not on the published menu, or arrives while a previous reply for the same decision is still in
flight. A repeated `decision-required` with the same request ID and revision does not release an
action already in flight. This remains true after stdin reaches EOF while the server is still
deciding whether to accept that action.

### Rejected submissions and correlation

A submission the server refuses comes back as an `error` carrying that submission's `requestId` and
`revision` (`ErrorPayload`, extended per ADR 0012 rather than adding a message type). Only that
correlated pair releases the in-flight guard, and only when it matches the reply actually
outstanding — then the decision may be answered again.

Every other `error` is uncorrelated: a connection-level refusal such as a player-session takeover,
or a problem with some other command entirely. None of them say whether the server accepted the
action it is holding, so the submission stays in flight and a second reply for that decision is
still refused locally. Assuming otherwise either submits one decision twice or leaves the client
waiting for a decision the server never re-asks.

Closing stdin with a reply in flight is legitimate — the server may still accept it. But a
correlated rejection arriving after EOF invites a retry that can never be written, so the client
emits a fatal `error` and exits non-zero instead of waiting forever. An unanswered decision at EOF
already fails the same way.

## What the agent is not told

Only `playerActionRequired` and `playerStateSnapshot` carry a `PlayerBoardState` — the same
anti-cheat projection the browser player gets. Every other server frame is spectator, replay, or
debug data and is dropped rather than translated, `stateSnapshot` and `replayUnlocked` most of all:
the second arrives immediately before `gameOver` in a single-player game and contains the full
board plus every seat's AI reasoning. The allow-list is explicit so a new server message cannot
leak by default, and `agent-client-core.test.ts` asserts that each of those frame types produces no
stdout event.

Nothing here filters the legal-action list. The server may already have filtered it for yielded
abilities; it is forwarded as received and never reconstructed.

The player view must never return opponent decklists or private card data.

## Sessions

A single-player session outlives its socket — the server holds it for a reconnect and refuses the
next `startGame` while it does. So the client sends `abandonGame` when its run ends, which is a
no-op on a finished or halted runner (`MatchRunner.abandon`) and therefore leaves the recorded game
with its real status. Without it one server process would be good for exactly one agent game.
`SIGINT`/`SIGTERM` abandon the same way before exiting.

## Table mode

`--table` plays one seat at a local table server (ADR 0031) instead of starting a single-player
game:

```bash
bun run agent-client --table 'http://127.0.0.1:3002/t/<table>#<invite>' --name Ann \
  --deck deck.txt --seat P2 [--policy first-legal]
```

- **Joining.** The client sends `joinTable` with the invite, then `requestSeat` with the decklist
  file's text. The host approves the claim (stderr shows its verification code). On `seatGranted`
  the client sends `resumeSeat` on the same socket. The seat token stays inside the process and is
  never printed.
- **Capabilities.** `rawActionData` is declared on `joinTable` and again on `resumeSeat`, since a
  resumed seat starts from what its resume declared.
- **Playing.** From the table's `gameStarted` for the granted seat on, events and replies are the
  single-player ones above. Request ids and revisions are the seat's own (`q1`, `q2`, ...), not the
  engine's.
- **Policies.** `stdin` (the default) reads replies as above. `first-legal` answers every decision
  with the first legal action and each target slot's first option, for scripted runs.
- **Clocks.** At a timed table a decision left unanswered past the seat's allowance and bank is
  answered by the seat's fallback bot. If a `seatStatus` says the fallback bot holds this seat
  while the client is connected, the client sends `resumeControl` to take it back.
- **Leaving.** The game belongs to the table, so the client never sends `abandonGame`; closing
  the process only disconnects the seat. Deck problems, a takeover by another connection, and a
  closed table end the run with a fatal `error`.
- **Loopback only** until the table server's production mode (plan M5).
