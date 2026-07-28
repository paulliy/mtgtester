# 0019 — Direct player controls remain an adapter over legal actions

Date: 2026-07-28

Status: Accepted

## Context

Phase 6 exposed a player-safe board plus engine-generated legal actions, but the first player
view still asked the user to select most actions from a text menu. That exposed implementation
detail instead of letting a player use the cards and battlefield they were looking at.

## Decision

1. Keep `Engine.submit()` and the offered action id as the only action authority.
2. Group legal source actions by their typed source object id. Clicking a legal hand card,
   battlefield permanent, or command-zone commander opens only that source's cast or ability
   choices.
3. Select targets from highlighted cards, permanents, and opponent panels, then confirm the
   exact offered action. The browser never reconstructs legality from text.
4. Expose public commander object identity and printing information in the player board so a
   command-zone commander can participate in the same interaction model.
5. Carry structured presentation facts for casts and activated abilities — source zone, mana
   cost, cast variant, commander tax, and modeled non-mana costs — rather than deriving them
   from action descriptions.
6. Retain a collapsed fallback control only for decision types without a dedicated board
   interaction.

## Consequences

- Land plays, ordinary casts, targets, activated abilities, and card-specific selections are
  card-first while retaining stale-request and server-side legality protection.
- Mana payment is still engine auto-payment, now shown as an explicit cost before confirmation.
  Manual selection among multiple valid mana-payment plans is a later Phase 7 increment; it
  requires an authoritative payment-plan selection contract rather than a UI-only toggle.
- The player view remains hidden-information safe: commander object identity is public only for
  a known commander and does not expose any opponent hand, library order, or deck contents.
