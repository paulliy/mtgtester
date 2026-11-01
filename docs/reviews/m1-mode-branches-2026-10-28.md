# Game-mode branches for M1 (ADR 0031 decision 2)

Date: 2026-10-28. Baseline: `7c09ad2`.

Every server branch on `GameMode`, classified for [multiplayer tables M1](../plans/multiplayer-tables.md).
A **flow** branch decides how a game runs: `'table'` behaves like `'singlePlayer'`, once per human
seat, and never falls into the spectator branch, which would start the presentation clock and send
`spectatorState`. A **fence** branch decides what a player may see: `'table'` takes the most
restrictive choice, which later milestones loosen only through the `DisclosurePolicy`. Each
branch becomes a `switch` on `GameMode` ending in `assertNever`, with a `// flow:` or `// fence:`
comment. Single-player and spectator behavior does not change.

Lines are at the baseline.

## `match/session.ts`

| Line     | What it decides                                                                       | Kind  | `'table'`                                                 |
| -------- | ------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------- |
| 231, 232 | who the human seat is                                                                 | flow  | every seat whose controller is `human`; at least one      |
| 300      | event batches go to the player                                                        | flow  | per human seat, through that seat's formatter             |
| 331      | live spectator presentation after events                                              | flow  | none                                                      |
| 334      | every advance is presented to the player at once                                      | flow  | per human seat                                            |
| 341      | `decisionPending` with the request                                                    | fence | never                                                     |
| 360      | halt reason                                                                           | fence | the fixed single-player message                           |
| 364      | halted card name                                                                      | fence | never                                                     |
| 391      | table talk sent at once                                                               | flow  | per human seat                                            |
| 394      | a note counts as reasoning only off a human seat (seat test, not a `GameMode` branch) | flow  | `humanSeats.has(...)`: off every human seat               |
| 412      | debug events                                                                          | fence | never                                                     |
| 430      | runner error message                                                                  | fence | the fixed single-player message                           |
| 441, 443 | presentation when compute ends; player state                                          | flow  | per human seat player state, no presentation clock        |
| 457      | playback mode                                                                         | flow  | live only, as single-player                               |
| 615      | debug flags                                                                           | fence | ignored                                                   |
| 871      | a proposal's talk and deal state sent at once                                         | flow  | per human seat                                            |
| 1027     | timeline seeking before the game ends                                                 | fence | refused with the fixed message, as single-player          |
| 1191     | player connection gate                                                                | flow  | per human seat                                            |
| 1318     | spectator final state                                                                 | flow  | none                                                      |
| 1339     | `replayUnlocked` after the game                                                       | fence | never in M1; M3 serves post-game replay from the table DB |
| 1562     | bots wait on the human's connection gate                                              | flow  | no wait (M1 task 6)                                       |
| 1597     | legal-menu escalation to the user                                                     | fence | never                                                     |

## Other modules

| Site                              | What it decides                                   | Kind  | `'table'`                                                        |
| --------------------------------- | ------------------------------------------------- | ----- | ---------------------------------------------------------------- |
| `match/annotations.ts:41`         | AI annotation release                             | fence | never (no seat sees another seat's notes)                        |
| `match/preview.ts:129`            | a seat's provider kind in the preview             | flow  | `human` for every human seat                                     |
| `ws/server.ts:402, 841`           | the human seat in a preview or start request      | flow  | `GameServer` refuses `'table'`: tables run only in `serve:table` |
| `ws/server.ts:562`                | setup refusal message                             | fence | the fixed `SETUP_REFUSED_MESSAGE`                                |
| `ws/server.ts:824`                | requester identity checks                         | fence | refused (see 402)                                                |
| `ws/server.ts:918, 928, 929, 950` | player socket, session token, start frame routing | flow  | refused (see 402); one human seat maps to `playerSocket`         |
| `cli/agent-client-core.ts:447`    | which `gameStarted` frames the agent adopts       | flow  | ignored until the agent's table mode (M3)                        |
| `ws/server.ts:298`                | annotations route lock until the game ends        | fence | locked until finished, as single-player                          |
| `ws/server.ts:336`                | debug and export route lock until the game ends   | fence | locked until finished, as single-player                          |
| `ws/server.ts:441`                | game report availability                          | fence | 404: only a single-player session has a report                   |
| `ws/server.ts:680`                | `resumeGame` accepts only a player session        | flow  | refused; unreachable, `GameServer` refuses table games           |
| `ws/server.ts:715`                | `holdsPlayerSeat`: a game guards its player       | flow  | no seat held; unreachable, `GameServer` refuses table games      |
| `ws/server.ts:734`                | `onSocketClose` orphan timer                      | flow  | no-op; unreachable, `GameServer` refuses table games             |
| `ws/server.ts:747`                | `startPlayerIdleTimer`                            | flow  | no-op; unreachable, `GameServer` refuses table games             |
| `ws/server.ts:795`                | `requireSession`: only the bound player socket    | fence | only the bound player socket                                     |
| `ws/server.ts:863, 886`           | setup refusal projection                          | fence | follows 824: the projected refusal for the requester's seat      |

The tester's `GameServer` never runs a `'table'` game: a start or preview request for one is
refused with the setup-refused message, so a table is reachable only through the table server.
