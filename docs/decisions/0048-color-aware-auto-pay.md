# ADR 0048: Color-aware auto-pay

Status: Accepted (2026-11-01)
Status note: renumbered from 0037 on 2026-11-14, because two ADRs had that number. [0037](0037-sampled-card-test-lab-and-weekly-runs.md) is the Card Test Lab sampling ADR.

Date: 2026-11-01

Amends [0003](0003-engine-core.md) decision 4, which still holds: the engine auto-pays every cost with a deterministic, exact solver.

Auto-pay tapped sources in battlefield order once lands had been put before artifacts and artifacts before creatures. With an Island ahead of three Swamps it paid the generic part of {1}{B} with the Island, leaving a {1}{U} spell in hand uncastable that turn. Players asked for the lands to be tapped the way they would tap them: spend what nothing else needs, and spend a color another spell or ability wants only when the payment cannot be made otherwise.

`manaSourcesFor` now orders sources within each tier by a keep value (`mana/tap-preference.ts`), and `planPayment`, which takes the first legal payment in the order it is given, taps the cheapest sources first. The tiers still come first: a creature is still only tapped when lands and artifacts cannot pay.

- **Demand.** The costs the player may want to pay next: spells in hand and their hand-activated abilities, commanders in the command zone, and activated abilities of their permanents. A spell being cast is on the stack (or the cast preview's stack) by the time it is paid for, so its own cost is not counted. For each of W, U, B, R, G and {C}, demand is the most pips of that symbol any one cost asks for. A hybrid pip counts towards each of its colors in proportion, and a Phyrexian pip in full.
- **Keep value.** A symbol's weight is its demand divided by the number of permanents that can make it, so one Island for a {U} spell is worth more than one of six. A permanent's value is the sum of the weights of the symbols it can make, plus a small amount per symbol so that, with nothing to tell them apart, a basic is spent before a dual.
- **Scope.** Every symbol is handled the same way, so five-color boards need no special case. Ordering never changes whether a payment is possible, because the solver is exact over any order. It changes which legal payment is found first, and the payment preview reads the same sources, so the highlighted lands are the ones tapped.
- **Board order where the player picks.** The manual mana list (ADR 0030) asks for board order (`manaSourcesFor(..., 'board')`), so its options do not move when the hand changes.

The ranking is a heuristic. A future payment can still find a needed color already spent when the demand estimate is wrong, for example for a card in the graveyard with flashback, which is not counted. Tapping choices also say something about the payer's hand, which is true of a human paying by hand too.

Validation: `packages/engine/tests/smart-tapping.test.ts` covers the Island-and-Swamps case in both directions, tapping a needed land when nothing else pays, a five-color board, a dual land, commander and activated-ability demand, and that the cast preview names the lands that are tapped.
