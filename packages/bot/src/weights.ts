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

  /**
   * Flat LEP charged per prior activation of the same ability this turn, subtracted AFTER the
   * decay above — the thing that makes a repeated activation's score actually cross zero instead
   * of merely approaching it.
   *
   * `repeatActivationDecay`'s own note says the damper only works because "a fixed cost subtracted
   * after decay is what lets repeated activation eventually score below `pass`". That reasoning
   * silently assumed every repeatable ability HAS a cost. A `{0}` activated ability has none, so
   * its score was `tempo.activateAbility * 0.6^n - 0` — strictly positive at every n, beating
   * `pass` forever. Found in a real game (`bun run combat-sweep --seed sweepA`, game 27): a
   * Hyalopterous Lemure's `{0}: ~ gets -1/-0 and gains flying` put **1,270 copies of itself on the
   * stack** in one priority window and the turn never ended.
   *
   * At 0.5 a free ability is taken about three times in a turn and then loses to `pass`, which is
   * the bound this damper was always supposed to provide.
   */
  repeatActivationPenalty: 0.5,

  /**
   * Bounded combat search (ADR 0024). Every number in this block is a STARTING value, not a
   * derived one — Decision item 5 says so in as many words, and the "Choosing the bounds"
   * section makes correcting them by measurement the job of sub-phase 7c. They live here, in
   * the one tuning surface, precisely so that sweep has a single place to turn.
   */
  combat: {
    /** Beam width for block-assignment candidate generation — the "top-K" of Decision item 3. */
    topK: 8,
    /**
     * Hard width cutoff (Decision item 5). Above either of these the search is skipped outright
     * and the Phase 4 static heuristic answers instead: search is an enhancement, never a
     * dependency, and a wide board is exactly where its cost grows fastest.
     */
    maxAttackers: 6,
    maxCombatPermanents: 8,
    /** Above this many live blockers, damage-division candidates are not enumerated (2^n subsets). */
    maxSplitBlockers: 5,

    /**
     * A creature's worth in LEP: this base, plus its stats and keywords below.
     *
     * Deliberately well above `sacrificePermanentValue`, and the tension is worth stating rather
     * than hiding. That weight prices a generic permanent surrendered to an ability cost; this one
     * prices a creature that is currently holding a board, and the two are not the same thing.
     * The number is also load-bearing in a way a placeholder isn't: it has to exceed a mid-size
     * attacker's power, or the search chump-blocks at full life — trading a body to prevent damage
     * that 40 starting life can comfortably absorb.
     */
    creatureBaseValue: 5,

    /**
     * Stats and keywords supply the difference between a 1/1 token and a commander, which is the
     * whole question in combat and nowhere else.
     */
    creaturePowerValue: 0.5,
    creatureToughnessValue: 0.25,
    keywordValue: 0.5,

    /**
     * What a point of an OPPONENT's life is worth to us, against our own at 1.0
     * (`lifePointValue`). Below 1 deliberately: in a four-player game, taking one opponent from
     * 40 to 33 is real progress but not a third of a win, and pricing it at parity with our own
     * life makes the attacker side race into losing board positions.
     */
    opponentLifePointValue: 0.5,

    /**
     * Flat term for a candidate that ends the game — subtracted when we would not survive, added
     * (scaled by `opponentLifePointValue`) when an opponent would not. Large enough to dominate
     * every body-and-life term, because it is categorically different from them: no amount of
     * board advantage is worth being dead.
     *
     * For our own side this is checked against life remaining AFTER the modelled response, not
     * after this combat alone. That is what makes chump-blocking come out right without a second
     * flat threshold: at 40 life a 1/1 declines to trade itself for 5 damage, and at 10 it chumps,
     * because only in the second case does declining leave the next swing lethal.
     */
    lethalSwingValue: 100,
  },
} as const;
