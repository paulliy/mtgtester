# Decktank mockup screens

These are the source files of the Decktank redesign mockups, kept as reference for
[the redesign plan](../../plans/decktank-redesign.md) and [ADR 0052](../../decisions/0052-decktank-visual-identity.md).

They do not open as working pages from this folder. Each one loads `support.js`, the viewer
runtime of the design tool they were made in; that runtime belongs to the tool and is not part of
this repository. Read them as source instead:

- The markup between `<x-dc>` and `</x-dc>` is the layout and styling, written as inline styles.
  `{{name}}` is a value filled in by the script; `<sc-for>` repeats and `<sc-if>` shows a branch.
- The `class Component` script at the bottom is the behaviour: state, handlers and the animation
  maths (for example `kickRings` and `dialMove` in `Main.dc.html`, `frame` and `draw` in
  `CombatDeclare.dc.html`).
- All data in them is sample data. Nothing here is a source of truth for cards, decks or results.

| File                                            | Screen                                                     |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `Main.dc.html`                                  | New game: compass, setup panel, inline deck picker         |
| `MainPhone.dc.html`                             | New game at phone width (imports `Main.dc.html`)           |
| `TopBar.dc.html`                                | Shared top bar with the ruler navigation                   |
| `Deck.dc.html`                                  | Earlier separate deck chooser, superseded by the inline one |
| `Board.dc.html`                                 | The board in combat, few cards                             |
| `BoardMedium.dc.html`, `BoardMany.dc.html`      | The same board at medium and high card counts              |
| `CombatDeclare.dc.html`                         | Declaring attackers and blockers, with the line animations |
| `CombatBlock.dc.html`                           | The blockers step (imports `CombatDeclare.dc.html`)        |
| `Stats.dc.html`                                 | Records: deck statistics and matchups                      |
| `Batches.dc.html`                               | Records: batch runs                                        |
| `CardLab.dc.html`                               | Workshop: Card test lab                                    |
| `Deals.dc.html`                                 | Workshop: deals preview                                    |
| `Debug.dc.html`                                 | Workshop: debug panel                                      |

The mockups show the day theme only. The night theme's values are in
[`apps/web/src/styles/tokens.css`](../../../apps/web/src/styles/tokens.css).
