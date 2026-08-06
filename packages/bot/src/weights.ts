/**
 * The bot's single tuning surface (ADR 0023 item 3). Every score the bot produces is expressed
 * in life-equivalent points (LEP), anchored on Commander's 40 starting life, so a cost and a
 * benefit are always comparable on the same scale. No magic number governing bot behavior may
 * live outside this table.
 *
 * Phase 1 values are deliberately simple placeholders — plausible orderings, not tuned weights.
 * Tuning them (by self-play win rate, see ADR 0023 item 12) is out of scope until a later phase.
 */
export const WEIGHTS = {
  /** `pass` always scores exactly this (ADR item 4) — the reference every action must beat. */
  passBaseline: 0,

  /**
   * Baseline value for taking an action at all, before its costs are subtracted, keyed by
   * `LegalAction.type`. Not zero for ordinary development plays: a quiet board with no visible
   * follow-up must not make `pass` win by default just because nothing looks flashy yet (item 4).
   */
  tempo: {
    /** Land drops are close to risk-free value; almost always worth taking. */
    playLand: 3,
    /**
     * Flat presence bonus for casting a spell, independent of the spell's actual impact.
     * `LegalAction.data` does not yet carry a numeric mana value (ADR item 19 — a projection
     * gap, not a bot gap), so this stands in for "spend mana, get a card's worth of board
     * impact" until that lands.
     */
    castSpell: 1.5,
    /**
     * Same placeholder reasoning as `castSpell`. Kept comparable to `playLand` rather than
     * lower: activated abilities routinely carry a real cost (`payLife`, sacrifice, discard —
     * `veto.ts`), and a baseline that a small cost can immediately swamp would make every such
     * ability lose to `pass` regardless of upside, which is the failure this scorer exists to
     * avoid (item 4).
     */
    activateAbility: 3,
  },

  /** 1 point of life paid = 1 LEP of cost. This is the LEP scale's anchor. */
  lifePointValue: 1,

  /**
   * Life total at or below which the bot's blocker targeting (`evaluate.ts`'s
   * `blockDeclarationTargets`) treats any incoming attacker as worth chump-blocking, not only
   * ones it can survive or trade with — a flat threshold standing in for the nonlinear
   * life-danger scoring the ADR notes as a future refinement, not yet built.
   */
  dangerousLifeThreshold: 10,

  /**
   * Flat placeholder value for a permanent given up to a sacrifice cost. `PermanentView` does
   * not carry mana value either (same gap as above), so every sacrificed permanent currently
   * costs the same regardless of what it actually is.
   */
  sacrificePermanentValue: 2,

  /** Flat placeholder value per card discarded (via `discardSelf`/`discardHand`). */
  discardCardValue: 1.5,

  /**
   * Multiplies an action's score by this factor for each prior activation of the *same* source
   * ability already chosen this turn (ADR item 5's repeat-activation damper). At 0.6, a fourth
   * activation in one turn scores at ~22% of its first-activation value — the mechanism that
   * makes a repeatable-but-pointless loop die out structurally instead of running until the veto
   * layer's hard floor stops it.
   */
  repeatActivationDecay: 0.6,
} as const;
