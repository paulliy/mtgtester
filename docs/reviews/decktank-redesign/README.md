# Decktank redesign: screenshots (2026-11-23)

Captured from real builds, not mocks: the tester (`serve` on the coverage Oracle fixture with a
scratch database, plus the Vite dev server) and the table app (`serve:table --dev` serving the
built table bundle). Each screen is shown in the day and the night theme. Card art is the
offline placeholder because the capture machine had no Scryfall access. Downscaled to 1280px wide.

| Screen                                | Day                                                           | Night                                                 |
| ------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------- |
| New game (compass, setup panel)       | `setup-day.jpg`, `setup-watch-day.jpg`, `setup-phone-day.jpg` | `setup-night.jpg`                                     |
| Stats                                 | `stats-day.jpg`                                               | `stats-night.jpg`                                     |
| Batch runs                            | `batch-day.jpg`                                               | `batch-night.jpg`                                     |
| Table: host a table                   | `table-home-day.jpg`                                          | `table-home-night.jpg`                                |
| Table: join by name                   | `table-join-day.jpg`                                          | `table-join-night.jpg`                                |
| Table: ask for a seat with a decklist | `table-claim-day.jpg`                                         | `table-claim-night.jpg`                               |
| Table: waiting for approval (guest)   | `table-pending-day.jpg`                                       | `table-pending-night.jpg`                             |
| Table: host panel with a request      | `table-host-day.jpg`                                          | `table-host-night.jpg`, `table-lobby-phone-night.jpg` |
| Table: opening hand                   | `table-opening-day.jpg`                                       | `table-opening-night.jpg`                             |
| Table: in game, with the table bar    | `table-game-day.jpg`                                          | `table-game-night.jpg`                                |
| Table: post-game and replay           | `table-postgame-day.jpg`                                      | `table-postgame-night.jpg`                            |

The board itself (seat panels, card tiles, combat) is phase 5 and 6 of the plan and still uses
the pre-redesign components, which follow the theme through the compatibility aliases.

## Game screen (phases 5 and 6, first pass)

`board-game-day.jpg`, `board-game-night.jpg` and `board-table-game-day.jpg`: the player board with
5:7 ink-framed tiles sized to fill each zone, Bodoni seat letters and life totals, the turn ruler
in a second bar row, hand tiles led by the commander, and the decision rail on paper-2. Card art
shows the paper tone here because the screenshot container cannot reach Scryfall.
