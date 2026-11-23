# ADR 0052: Decktank visual identity

Status: Accepted (2026-11-22)
Status note: Paul settled the night theme, the multiplayer link and the deferred import report on 2026-11-22. Whether batch setup folds into the New game screen stays open until phase 3 of the redesign plan.

Date: 2026-11-22

Amends [ADR 0021](0021-player-experience-overhaul.md) (the viewer's look and motion) and the
brief's §2 styling row. The work itself is planned in
[docs/plans/decktank-redesign.md](../plans/decktank-redesign.md), with the mockup screens in
[docs/design/decktank/](../design/decktank/).

## Context

The viewer has used one look since v1: a dense dark theme with a light `prefers-color-scheme`
variant, system fonts, and almost no motion, following the brief's "plain CSS, flat, minimal,
functional". A redesign was mocked up under the name Decktank: a light paper-and-ink look with a
serif display face, a compass-style New game screen, a ruler navigation, and animated combat
declaration. It keeps plain CSS and adds no library, but it changes the visual direction and the
amount of motion, so it needs a recorded decision.

## Decision

1. **Name.** The product's user-facing name is Decktank: the nav brand, the page title and the
   README heading. Package names (`@mtg/*`) and the repository name do not change.
2. **Tokens.** Every colour, font and easing is a CSS custom property in
   `apps/web/src/styles/tokens.css`. Components read tokens, never hex values. The old variables
   (`--bg`, `--surface`, `--surface-2`, `--line`, `--text`, `--text-muted`, `--muted`, `--accent`,
   `--ok`, `--warn`, `--danger`) stay as aliases of the new tokens, so unrestyled components follow
   the theme until each is restyled.
3. **Day and night.** Both themes ship. Night follows `prefers-color-scheme: dark` unless the
   player picks Day or Night; the choice is stored in `localStorage` under `decktank.theme` and
   applied as `data-theme` on `<html>` before first paint. Night is warm charcoal, not blue-black.
   The values are the table in the plan's phase 0, decision 3. Body text and small muted text
   clear 4.5:1 on both page and panel colours in both themes, and every colour pip's letter
   clears 4.5:1 on its fill; a unit test holds that.
4. **Colour identity.** White, blue, black, red, green and colourless use muted fills with a 1px
   ink ring and a serif letter, in WUBRG order, with one accessible name listing the colours.
5. **Fonts.** Bodoni Moda (display), Archivo (labels and buttons) and Cutive Mono (body), all under
   the SIL Open Font License, are self-hosted in `apps/web/public/fonts/` as Latin subsets. The
   app runs locally and offline, so no font is loaded from a third-party host.
6. **Motion.** CSS transitions and `requestAnimationFrame` loops are allowed; an animation library
   is still not. Every animation stops under reduced motion (`prefers-reduced-motion` or the
   app's own setting), and no animation delays a state change: state lands at once and motion is
   decoration.
7. **Multiplayer.** The New game screen's multiplayer option is, for now, a link to the hosted
   tables at `https://decktester.poilygon.dev/` in a new tab. It never starts or exposes the local
   tester server, which must not be reachable from other machines
   ([table hosting](../guides/table-hosting.md)).
8. **Import report.** The failed-import report and its work order for a language model are
   deferred. A blocked import keeps today's preview message.

## Consequences

- Phase 1 of the plan moves every screen to the new theme with no component edits, through the
  aliases; later phases restyle components one at a time and may then drop aliases they no longer
  need.
- Screenshots and browser-trial evidence must show both themes for any restyled screen.
- The three font files add about 93 KB to the first load. Their licence texts ship beside them.
- Night tokens double the colour review: a new colour needs a night value and a contrast check.
