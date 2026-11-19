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

  /**
   * Card-aware scoring (ADR 0039, `policy.ts`). Starting values chosen by hand and then checked
   * by the bot league (`bun run bot-league`); every one is a candidate for self-play tuning.
   */
  policy: {
    /** A land drop beats every spell: it is free mana for the rest of the game. */
    playLand: 12,
    /** Activating a mana ability on its own just floats mana that empties at the next step. */
    floatManaPenalty: -1,
    /** A cast is worth this plus its mana value times `castPerManaValue`, plus its roles. */
    castBase: 1.5,
    castPerManaValue: 1,
    /** Per point of printed power on a creature spell. */
    creaturePowerOnCast: 0.3,
    /** Extra value per role; context-dependent roles are computed in `policy.ts`. */
    roles: {
      removal: 3,
      wipe: 0,
      counter: 0,
      draw: 2,
      ramp: 2.5,
      tokens: 1.5,
      pump: 0.5,
      protection: 0.5,
      recursion: 1.5,
      tutor: 2,
      burn: 1.5,
      lifegain: 0.5,
      discard: 1,
      extraTurn: 6,
      /** A counterspell with an opponent's spell on top of the stack. */
      counterAnswer: 8,
      /** A counterspell with nothing to counter: never cast it into an empty stack. */
      counterIdle: -20,
    },
    /** Share of the best hostile target's LEP that a removal spell is worth. */
    removalTargetShare: 0.6,
    /** Share of a creature's worth counted when the targeted damage would leave it alive. */
    nonlethalDamageShare: 0.1,
    /** A board wipe is worth this share of (their creatures - our creatures x weight). */
    wipeNetShare: 0.4,
    wipeOwnLossWeight: 1.3,
    /** A pump or protection instant cast with nothing on the stack and no combat. */
    idleTrickPenalty: 8,
    /**
     * A sorcery-speed cast that drops untapped mana below what the seat should keep up: the
     * strategist's `holdUpMana`, but only for instant-speed interaction it actually holds.
     */
    holdUpPenalty: 10,
    /** Interaction dearer than this is not worth keeping mana up for every turn. */
    holdUpMaxInteractionCost: 3,
    /**
     * Mana that must stay free to develop: holding mana up never stops a three-drop, so turns one
     * to three play out normally and holding 2 starts with a fifth mana source.
     */
    holdUpDevelopMana: 3,
    /** Strategist steering by card name. */
    prioritizeBonus: 6,
    holdPenalty: 12,
    /** `avoidOverextending`: creature spells past this many creatures lose this much. */
    overextendCreatures: 3,
    overextendPenalty: 4,

    /** Opponent threat: board value share plus life lost share, plus the steering order bonus. */
    threatBoardWeight: 0.1,
    threatLowLifeWeight: 0.15,
    steeringTargetBonus: 1,
    /** How much opponent threat counts when choosing among hostile targets. */
    targetPressureWeight: 0.3,

    /** Attacks: aggression thresholds for safe and risky swings, and target bonuses. */
    defaultAggression: 0.5,
    safeAttackAggression: 0.2,
    riskyAttackAggression: 0.75,
    safeAttackBonus: 2,
    lethalAttackBonus: 50,
    planeswalkerAttackDiscount: 1,

    /** Mulligan: keep 7 with this many lands, inclusive. */
    mulliganMinLands: 2,
    mulliganMaxLands: 5,
    /** Bottom a land when lands are more than this share of the hand. */
    bottomLandShare: 0.45,

    /** Equip that only moves equipment to a worse creature, or crew with nothing to attack. */
    pointlessActivation: -2,

    /** Values for things in hand and on the battlefield. */
    landPermanentValue: 2,
    otherPermanentBase: 2,
    otherPermanentPerManaValue: 0.8,
    enoughLands: 6,
    excessLandCardValue: 0.5,
    neededLandCardValue: 3,
    spellCardBase: 1,
    spellCardPerManaValue: 0.6,

    /** Resolution choices: accepting a may-trigger beats declining it. */
    acceptOptional: 1,
    choiceBase: 20,
    /** An "another target" action whose slots cannot all get different objects. */
    impossibleTargets: -100,

    // --- ADR 0043 fixes (`fixes.ts`); starting values, gated by bot-bench seeds and the league ---
    /** Removal on the attacker whose damage makes the incoming total lethal, when that saves us. */
    saveFromLethalBonus: 60,
    /** Otherwise, per point of damage an attacker in a lethal attack would deal. */
    lethalThreatPerDamage: 2,
    /** Removal on the blocker that stands between this turn's attack and a kill. */
    clearBlockerBonus: 40,
    /** A pump that carries an attack over the defending player's life. */
    lethalPumpBonus: 60,
    /** Per point of damage a pump adds to an attack that does not kill. */
    pumpDamageValue: 0.5,
    /** A spell that turns this turn's attack into a kill. */
    lethalSpellBonus: 25,
    /** Yielding the turn while an instant-speed action is on the menu: just below `pass`. */
    yieldWhileHolding: 0.25,
    /** The spell that begins the casting order spending the most mana this turn. */
    castOrderBonus: 4,
    /** A land that enters untapped and lets a spell in hand be cast this turn. */
    landUnlockBonus: 1,
    /** Per colour a land adds that the hand needs more sources of. */
    landColorNeedBonus: 0.5,
    /** On a turn no land unlocks anything, the tapped land is free to play. */
    idleTappedLandBonus: 0.25,

    // --- Answer discipline and face damage (`scarceAnswer`, `faceDamage` fixes) ---
    /**
     * The last counterspell or hard removal of its kind in hand (ADR 0044's `scarce-answer`) is
     * kept for a real threat unless lethal is on the public board. Below these thresholds the cast
     * scores just under passing, so the bot keeps the card; a strategist `prioritize` still lifts it.
     */
    scarceAnswer: {
      /** A countered spell must reach this: its mana value plus `bigEffectBonus` if it has one. */
      minCounterThreat: 4,
      /** Hard removal's best target must reach this in LEP, lethal and clear-the-blocker bonuses included. */
      minRemovalThreat: 9,
      /** Added for a wipe, an extra turn or a team pump: effects that swing a game whatever their cost. */
      bigEffectBonus: 3,
      /** How far below passing a held answer scores. */
      holdMargin: 1,
    },
    /**
     * Damage at a player that does not kill is worth this per point (times 0.5 + aggression), in
     * place of the flat value of a player target. Killing damage keeps the flat value.
     */
    faceDamagePerLife: 1,
    /** `commanderValue`: added to a commander's permanent value, on either side of the table. */
    commanderPermanentBonus: 4,
    /** `riskyAttackValue`: an unsafe attacker at or below this power needs an attack trigger. */
    riskyAttackMinPower: 1,
    /** `holdUpRelief`: from this many cards in hand, cleanup would discard, so the mana is spent. */
    holdUpFullHand: 7,
  },

  /**
   * Table diplomacy (ADR 0035). Off unless a game enables it, and every number here is a starting
   * value for the self-play comparison the ADR asks for, not a measured one.
   */
  deals: {
    // --- Position (decision 7) ---
    /** Each life point at or below `dangerousLifeThreshold` counts this many times. */
    lowLifeMultiplier: 2,
    /** Per noncreature, nonland permanent: an engine piece is worth something, but not a body. */
    noncreaturePermanentValue: 3,
    landValue: 1,
    cardInHandValue: 1.5,
    /** Per poison counter: ten of them are a loss, like 40 life. */
    poisonCounterValue: 4,

    // --- Win share and leader (decisions 8 and 9) ---
    /** Softmax temperature over positions, in LEP. Lower makes the leader look more certain. */
    winShareTemperature: 20,
    /** A seat is the leader when its win share is at least this many times the mean. */
    leaderShareRatio: 1.5,
    /** Commander damage taken from one opponent at which a seat counts as in danger. */
    commanderDamageDanger: 15,

    // --- Pressure and attack preference (decisions 10 and 16) ---
    /** How much more damage to the leader is worth, per unit of win share above the mean. */
    leaderFocus: 1,
    /** A planeswalker as an attack target, as a fraction of attacking its controller. */
    planeswalkerFactor: 0.5,
    /** Softmax temperature for where a seat's attacks are predicted to go, in LEP. */
    attackPreferenceTemperature: 2.5,
    /** Flat per-round value of not being targeted by one seat's spells and abilities. */
    targetInteractionValue: 3,
    /** Flat per-round value of not having one seat target your spells. */
    counterInteractionValue: 1.5,
    /**
     * Hand size at which a seat counts as fully able to interact. A promise not to target or
     * counter is worth `handSize / this` (capped at 1) of the flat value: a seat with no cards
     * promises nothing.
     */
    fullInteractionHandSize: 4,
    /**
     * Share of the flat interaction value the promiser itself gives up per round: it still
     * interacts, but at whoever it would have liked less.
     */
    interactionForegoneShare: 0.5,
    /**
     * Share of its attack power a seat must send at the target to meet `attackPlayer`. A token
     * attack does not count, and the deal is valued at this share, not the seat's whole attack.
     */
    attackPlayerShare: 0.5,

    // --- Deal value (decision 11) ---
    /** λ: how much an opponent's gain costs us at an even win share. */
    opponentGainWeight: 0.5,
    /** Each later round of a deal counts this much of the one before it. */
    roundDiscount: 0.7,
    maxRounds: 2,
    /** Most obligations one side may owe in a deal; more is padding (ADR 0035 decision 15). */
    maxObligationsPerSide: 2,

    // --- Trust (decision 12) ---
    basePKeep: 0.6,
    maxPKeep: 0.95,
    /** Each breach multiplies the breaker's keep probability by this. */
    brokenDecay: 0.4,
    /**
     * Least a party's own promises must have cost it (LEP) for keeping them to earn any trust. A
     * deal kept for free (a gift, a promise not to attack someone it never wanted to) earns none,
     * and a deal earns at most what it cost the keeper, never its full size.
     */
    minTrustCost: 1,
    /** A seat with this many breaches is refused outright. */
    maxBreachesTolerated: 2,

    // --- Acceptance (decision 15) ---
    acceptThreshold: 1,
    /** Seeded uniform noise on the threshold, ±this, so probing cannot find it. */
    thresholdNoise: 1,
    /** Early-game rounds in which a slightly bad deal may be accepted to build trust. */
    investmentRounds: 3,
    investmentAllowance: 2,
    /** Rounds before the same proposer may propose the same terms again after a decline. */
    reproposeCooldownRounds: 2,
    /** Rounds a pair waits after one deal ends before starting another: no endless renewal. */
    pairCooldownRounds: 1,

    // --- Keeping, breaking and proposing (decisions 17 and 18) ---
    /**
     * Reputation cost of a breach with every starting opponent still alive. Above a typical
     * redirected swing (a few LEP) so deals hold in ordinary turns, far below the lethal term so
     * no deal survives a kill.
     */
    breakPenalty: 10,
    /** Propose when one seat's predicted attack could take at least this share of our life. */
    proposePressureShare: 0.25,
  },

  /**
   * Play styles (`BotSteering.style`, `styles.ts`). `defaults` fill knobs the strategist left
   * unset; the scales multiply policy weights. Starting values, not measured ones: the bot league
   * (`bot-league --a styled ...`) is the gate, as for every other weight here.
   */
  styles: {
    aggro: {
      defaults: { aggression: 0.85, holdUpMana: 0, avoidOverextending: false },
      /** Multiplies `policy.faceDamagePerLife`. */
      faceDamage: 1.5,
      /** Multiply `policy.scarceAnswer.minCounterThreat` and `minRemovalThreat`. */
      counterThreshold: 1.25,
      removalThreshold: 1.25,
      /** Multiply flat role values in `policy.roles`, and the removal target share. */
      roles: { pump: 2, burn: 1.5, tokens: 1.3, draw: 0.75 },
    },
    /** Between aggro and midrange: presses the attack without giving up card value. */
    tempo: {
      defaults: { aggression: 0.7 },
      faceDamage: 1.25,
      counterThreshold: 1.1,
      removalThreshold: 1.1,
      roles: { pump: 1.5, burn: 1.25, tokens: 1.15, draw: 0.9 },
    },
    midrange: {
      defaults: {},
      faceDamage: 1,
      counterThreshold: 1,
      removalThreshold: 1,
      roles: {},
    },
    /**
     * Between midrange and control: values cards and answers like control but plays at the plain
     * bot's pace. The control ablation found the passive knobs, not the weights, cost games.
     */
    value: {
      defaults: {},
      faceDamage: 0.75,
      counterThreshold: 1,
      removalThreshold: 1,
      roles: { draw: 1.25, removal: 1.15, recursion: 1.15 },
    },
    /**
     * No knob defaults: holding up mana and playing passively cost games in the mirrors and in the
     * gauntlet (`bot-gauntlet`, ADR 0050). Control is how it values cards and answers.
     */
    control: {
      defaults: {},
      faceDamage: 0.5,
      counterThreshold: 0.75,
      removalThreshold: 0.8,
      roles: { draw: 1.5, removal: 1.3, recursion: 1.3 },
    },
    /** Between midrange and combo: builds mana and cards first, keeps answers for big threats. */
    ramp: {
      defaults: { aggression: 0.4 },
      faceDamage: 0.75,
      counterThreshold: 1.1,
      removalThreshold: 1,
      roles: { ramp: 1.5, draw: 1.25, tutor: 1.25 },
    },
    combo: {
      defaults: { aggression: 0.2 },
      faceDamage: 0.5,
      counterThreshold: 1.25,
      removalThreshold: 1,
      roles: { tutor: 2, draw: 1.25, ramp: 1.3 },
    },
  },
} as const;
