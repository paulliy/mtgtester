# ADR 0055: Claude bots at multiplayer tables

Status: Proposed (2026-11-26)

Date: 2026-11-26

Amends [ADR 0031](0031-multiplayer-tables.md) decision 10, which kept LLM seats off tables
until they had their own design and a per-table call cap.

## Context

Table bot seats always ran the heuristic bot (`providerKind: 'random'` in
`table/in-process-port.ts`). Single-player games can give bot seats to Claude, the strategist and
tactician in `ai/` ([ADR 0039](0039-bot-led-tactics.md)), but a table could not, for three reasons
from decision 10:

1. Cost reports would leak a bot's hand.
2. Nothing bounded a host's spending.
3. A table must keep moving for the people at it.

Since then, the table disclosure policy has fenced cost reports, raw error text and debug events
by policy, not by provider kind (`tablePolicy()`), and a bot seat's notes go only to its own seat.
That settles reason 1. Table clocks time only human seats, so a slow model call never times a bot
out. But every human at the table waits while a bot thinks.

## Decision

1. **The host chooses, per table.** `hostSetBots { bots: 'builtin' | 'claude' }` sets who plays
   every bot seat, while the table is open. The table state carries `bots` and `claudeBots`, which
   says whether the server can offer Claude. The default is `builtin`. One choice covers every
   bot seat, because a session runs one bot kind ([`resolveSeatControllers`](../../packages/server/src/match/session.ts)).
   The protocol version goes to 2.
2. **The server offers Claude only when it has a key.** `TABLE_CLAUDE_BOTS` is `auto` (the default:
   on when `loadAiConfig` finds a key) or `off`. If the host asks for Claude when it is not offered,
   the request is refused with `claudeUnavailable`.
3. **Claude plans and the bot moves.** A table's model seats run in `bot` tactical mode with no
   escalation triggers. The strategist plans each turn ahead, prefetched at the turn boundary, and
   the card-aware bot makes every move from that plan. Nobody at the table waits on a model call.
   On the fixed-deck census that is about 0.4 calls per turn, where `model` mode makes about 3.75.
4. **Every tactical call is bounded.** If a table ever asks the tactician, the call gets at most
   8 seconds and no retry. A timeout or failure goes to the heuristic bot through the provider's
   existing fallback, since a table has no escalation hook.
5. **A per-game call cap.** After 300 network attempts in a game, every bot seat plays as the
   heuristic bot for the rest of that game, and turn-boundary prefetches stop. A call that is
   already in flight may still finish.
6. **The AI code loads only at a Claude table.** Importing the model services costs a worker about
   60 MB of RSS (measured: 50 MB to 113 MB). The worker loads them on demand, so a built-in-bot
   table costs what it did before. That matters on the 1 GB host.
7. **Reflections stay off at tables.** Decision 10 still holds for post-game reflection.

## Consequences

- A table's bill is bounded by the call cap, and no more than the strategist's usual spend in a
  single-player game.
- A Claude table worker uses about 60 MB more memory than a built-in one.
- A seat that a person leaves still goes to the heuristic fallback bot, never to Claude (decision 9
  of ADR 0031 is unchanged).
- Letting Claude make every move (`model` mode) at a table is a constant away
  (`TABLE_MODEL_BOTS.tacticalMode`). The 8-second bound already covers it.
