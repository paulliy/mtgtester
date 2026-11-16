/**
 * Rule-modifying statics (ADR 0010, Inc 13) — continuous effects that change the RULES of
 * casting or countering, rather than a permanent's characteristics.
 *
 * `StaticEffect`/`ContinuousOp` (`continuous-types.ts`) only express CR 613 layer operations
 * over PERMANENTS. "Your opponents can't cast spells" and "spells you cast cost {1} less" have
 * no permanent to apply an op to — the thing they modify is an action (casting) or an object
 * that is not yet on the battlefield (a spell on the stack) — so they get their own category
 * rather than being squeezed into the layer engine `gatherEffects` already assumes is
 * permanent-shaped.
 */

import type { Color } from '@mtg/shared';
import type { ManaUnit, ParsedManaCost } from '../mana/cost';
import type { Condition } from './condition';
import type { Selector } from './selector';
import type { Value } from './value';

export type RuleStatic =
  | { kind: 'cantBlockMatching'; filter: Selector }
  | { kind: 'cantBeSacrificed' }
  /** "~ can't be the target of abilities your opponents control" (Shanna, CR 115.1). */
  | { kind: 'cantBeTargetedByOpponentAbilities' }
  | { kind: 'cantAttackOwner' }
  | { kind: 'opponentNonHandSpellCostIncrease'; amount: number }
  /**
   * "Noncreature spells cost {1} more to cast" (Thalia), "Spells your opponents cast cost {1} more
   * to cast" (Grand Arbiter Augustin IV), "Each spell costs {3} more to cast except during its
   * controller's turn" (Defense Grid). A cost increase (CR 601.2f): it is added to the total cost
   * before any reduction, applies to alternative and "without paying its mana cost" casts alike
   * (CR 118.9d), and never changes the spell's mana value. `filter` is read against the spell as
   * it is being cast; `opponentsOnly` exempts the static's controller; `exceptCastersTurn` turns it
   * off on the caster's own turn.
   */
  | {
      kind: 'spellCostIncrease';
      amount: number;
      filter?: Selector;
      opponentsOnly?: true;
      exceptCastersTurn?: true;
    }
  /**
   * "You may cast [filter] spells as though they had flash" (Vedalken Orrery, Yeva) and "Any
   * player may cast [filter] spells as though they had flash" (Tidal Barracuda): a timing
   * permission only (CR 601.3b, 702.8a). It never lets a card be cast from another zone, changes
   * no cost, and never lets a land be played. `filter` is read against the spell as it would be
   * cast; `allPlayers` extends it to every player.
   */
  | { kind: 'castAsThoughFlash'; filter?: Selector; allPlayers?: true }
  /**
   * CR 103.6a: a Leyline begins the game on the battlefield. Gemstone Caverns adds conditions and
   * a cost: only for a player who isn't the starting player, with one counter of `withCounter`,
   * and "if you do, exile a card from your hand".
   */
  | {
      kind: 'beginOnBattlefieldFromOpeningHand';
      notStartingPlayer?: true;
      withCounter?: string;
      exileCardFromHand?: true;
    }
  | { kind: 'effectDiscardMayGoToLibraryTop' }
  /** Redirect a matching graveyard move before any zone-change or dies event. */
  | {
      kind: 'graveyardToExile';
      scope: 'all' | 'opponents';
      basis: 'owner' | 'controller';
      includeTokens: boolean;
      creatureFromBattlefieldOnly?: true;
    }
  /** "Spells you cast cost {1} less to cast" (Temur Battlecrier) / Eminence (The Ur-Dragon). */
  | {
      kind: 'costReduction';
      /** Generic-mana amount to reduce by. A `Value` so a dynamic count (Temur Battlecrier's
       * "for each creature you control with power 4 or greater") is expressed the same way a
       * fixed {1} (Eminence) is. */
      amount: Value;
      /** Colored-mana reduction (CR 601.2f — Morophon's {W}{U}{B}{R}{G} reduction). */
      coloredAmount?: ParsedManaCost;
      /** Restrict to spells matching this (printed) filter — "Dragon spells". Absent ⇒ any spell. */
      filter?: Selector;
      /** "OTHER Dragon spells" (Ur-Dragon) — excludes the source's own printed card. */
      excludesSelf?: boolean;
      /** "During your turn" (Temur Battlecrier) — inactive on any other player's turn. */
      yourTurnOnly?: boolean;
      /** Eminence (CR 702.114): active from the command zone too, not just the battlefield. */
      alsoFromCommandZone?: boolean;
      /** Affinity-style reduction printed on the spell itself, not granted from the battlefield. */
      selfOnly?: boolean;
      /**
       * "Boast abilities you activate cost {1} less to activate for each Dragon you control"
       * (Dragonkin Berserker) — this reduction applies to ACTIVATING an ability, not casting a
       * spell. Omitted defaults to `'cast'`, the overwhelmingly common case every other card
       * here uses.
       */
      appliesTo?: 'cast' | 'activate';
      /**
       * "Spells you cast that target a creature cost {2} less to cast" (Killian, Ink Duelist): the
       * reduction applies only when one of the spell's chosen targets matches. Total cost is
       * locked in after targets are chosen (CR 601.2c, 601.2f), so `costReductionFor` leaves these
       * out and `targetedCostReductionFor` prices them against the actual targets.
       */
      targetFilter?: Selector;
      /**
       * "Boast abilities you activate cost {1} less" (Dragonkin Berserker): an activation
       * reduction for Boast abilities only (CR 702.142), whatever permanent has them.
       */
      boastOnly?: true;
      /**
       * "Activated abilities of cards in your graveyard cost {2} less to activate" (Convergence of
       * Dominion): an activation reduction for graveyard-zone abilities only.
       */
      graveyardAbilities?: true;
      /** "This effect can't reduce the mana in that ability's activation cost to less than N". */
      minimumMana?: number;
      /** "As long as you control your commander" — the reduction applies only while true. */
      condition?: import('./condition').Condition;
      /**
       * "Creature spells of the chosen type cost {2} less to cast" (Urza's Incubator): no "you
       * cast", so the reduction applies to every player's spells, not only its controller's.
       */
      allPlayers?: true;
    }
  /**
   * "Creature spells you control can't be countered" (Rhythm of the Wild) — a STATE-DEPENDENT
   * rule, unlike `Ability.cantBeCountered`'s fixed-at-cast property (Last March of the Ents):
   * this one exists only while the source is on the battlefield and can stop applying if it
   * leaves before the spell resolves.
   */
  | { kind: 'cantBeCountered'; filter?: Selector }
  /** "Your opponents can't cast spells during your turn" (Dragonlord Dromoka). */
  | {
      kind: 'cantCastSpells';
      who: 'opponents' | 'all';
      yourTurnOnly: boolean;
      duringCombatOnly?: boolean;
    }
  /** Each player's own cast tally applies, including spells cast before the source entered. */
  | { kind: 'spellCastLimit'; category: 'any' | 'noncreature'; limit: number }
  | { kind: 'otherPermanentsEnterTapped'; filter: Selector }
  /**
   * "Untap all permanents you control during each other player's untap step" (Seedborn Muse,
   * CR 502.3): part of the untap turn-based action of every player but the source's controller,
   * so it uses no stack. `filter` narrows which of the controller's permanents untap.
   */
  | { kind: 'untapDuringOthersUntapSteps'; filter?: Selector }
  | { kind: 'suppressObjectTriggers'; events: ('enters' | 'dies')[]; filter: Selector }
  /**
   * "You may cast Dragon spells from the top of your library" (Korlessa, Scale Singer).
   * `lifeInsteadOfMana`: "If you cast a spell this way, pay life equal to its mana value rather
   * than pay its mana cost" (Bolas's Citadel) — an alternative cost (CR 118.9), so a spell cast
   * under it is never cast for mana, and X is 0 (CR 107.3b).
   */
  | { kind: 'castFromZone'; zone: 'libraryTop'; filter?: Selector; lifeInsteadOfMana?: true }
  /** Private permission to look, without revealing the library top to other players. */
  | { kind: 'lookTopLibrary' }
  /** "You may play lands from the top of your library/your graveyard." */
  | {
      kind: 'playFromZone';
      zone: 'libraryTop' | 'graveyard';
      filter?: Selector;
      /** Muldrotha-style permission is active only during its controller's turn. */
      yourTurnOnly?: boolean;
      /** Maximum uses of this permission for each permanent type during a turn. */
      permanentTypeBudget?: number;
    }
  /** Add mana inline when a matching permanent's mana ability is activated. */
  | {
      kind: 'manaActivationRider';
      source: Selector;
      add:
        | { kind: 'fixed'; units: ManaUnit[] }
        | { kind: 'oneOfProducedTypes' }
        /** Caged Sun: one more mana of the source's chosen color, when that color is produced. */
        | { kind: 'chosenColorIfProduced' };
    }
  /** "Play with the top card of your library revealed." */
  | { kind: 'revealTopLibrary' }
  /**
   * "The same is true for creature spells you control and creature cards you own that aren't on
   * the battlefield" (Biotransference): an object of `ifType` gains `addTypes` on the stack (if
   * this permanent's controller controls it) and in every other zone but the battlefield (if they
   * own it). The battlefield half is an ordinary layer 4 static.
   */
  | { kind: 'alsoTypesOffBattlefield'; ifType: string; addTypes: string[] }
  /**
   * "Each nonland card in your hand without foretell has foretell. Its foretell cost is equal to
   * its mana cost reduced by {2}." (Dream Devourer, CR 702.143a): the foretell special action
   * for its controller's hand cards, each keeping that cost once foretold.
   */
  | { kind: 'grantForetell'; reduction: number }
  /** Additional land plays available to the controller each turn. */
  | { kind: 'additionalLandDrops'; count: Value }
  /** Opponents/players cannot activate abilities of matching battlefield sources. */
  | {
      kind: 'cantActivateAbilities';
      who: 'opponents' | 'all';
      yourTurnOnly: boolean;
      filter: Selector;
    }
  /** "If a creature you control that entered this turn would deal damage, it deals twice that
   * much damage instead" (Neriv, Heart of the Storm) — a damage REPLACEMENT effect (CR 616). */
  | { kind: 'damageDoubled'; sourceFilter: Selector }
  /** "Sources would deal damage to an opponent or their permanents" (Gisela). */
  | { kind: 'damageDoubledToOpponents'; sourceControllerOnly?: true }
  /**
   * A damage replacement (CR 614.1a, 616.1): "If a source you control would deal damage to a
   * permanent or player, it deals triple that damage instead" (Fiery Emancipation), "If a red
   * source you control would deal damage to an opponent or a permanent an opponent controls, it
   * deals that much damage plus 2 instead" (Torbran). Each damage event (one source to one
   * recipient) is replaced once (`factor` multiplies, `plus` adds); when several apply, the
   * affected player orders them (`damage-modifiers.ts`).
   *
   * - `sourceFilter`: the source as it deals the damage, from this permanent's point of view
   *   (`YOURS` for "you control"). Absent: any source.
   * - `excludesSelf`: "another source" — never this permanent's own damage.
   * - `recipient`: `any` ("a permanent or player"), `opponents` ("an opponent or a permanent an
   *   opponent controls"), or `opponentPlayers` ("an opponent").
   * - `noncombatOnly`: "noncombat damage" (Solphim, Tor Wauki).
   */
  | {
      kind: 'damageReplacement';
      sourceFilter?: Selector;
      excludesSelf?: true;
      recipient: 'any' | 'opponents' | 'opponentPlayers';
      noncombatOnly?: true;
      factor?: number;
      plus?: number;
    }
  /**
   * "If you would gain life, you gain twice that much life instead" (Rhox Faithmender), "...
   * that much life plus 1 instead" (Knight of Dawn's Light): a replacement of each life-gain
   * event of this permanent's controller (CR 614.1a, 119.10). Several are ordered by that player
   * (CR 616.1); "whenever you gain life" sees only the final amount.
   */
  | { kind: 'lifeGainReplacement'; factor?: number; plus?: number }
  /** "Sources would deal damage to you or your permanents" (Gisela). */
  | { kind: 'damageHalvedToYou' }
  /**
   * "Prevent all combat damage that would be dealt to this creature" (Guard Gomazoa) — a CR 615
   * prevention effect of the permanent itself, so it stops with the permanent's abilities.
   */
  | { kind: 'preventCombatDamageToSelf' }
  /** "If an effect would create one or more tokens under your control, it creates twice that many instead." */
  | { kind: 'tokenCountMultiplier'; multiplier: number }
  /** A CR 616 replacement for counters placed on a matching permanent. */
  | {
      kind: 'counterPlacementReplacement';
      filter: Selector;
      counter?: string;
      multiplier: number;
      addition: number;
    }
  /**
   * "Creatures can't attack you unless their controller pays {N} per creature" (Ghostly Prison):
   * taxes attacks on this permanent's controller only. `includePlaneswalkers` also taxes attacks
   * on planeswalkers they control ("you or planeswalkers you control", Norn's Annex).
   */
  | { kind: 'attackTax'; amount: number; phyrexianColor?: Color; includePlaneswalkers?: boolean }
  /**
   * "Creatures matching `filter` can't attack you or planeswalkers you control" (Combat
   * Calligrapher, Eriette, Rite of the Raging Storm), or, with `cost`, "… unless their controller
   * pays {X}" (Nils, Discipline Enforcer: X is the number of counters of all kinds on that
   * creature). `filter` is read against the creature as it would attack, from this permanent's
   * controller's point of view, and the restriction is about attacks on that controller only. A
   * restriction always wins over an attack requirement (CR 508.1c), and a cost is paid per
   * creature, never forced (CR 508.1d, 508.1g-h).
   */
  | {
      kind: 'attackRestriction';
      filter: Selector;
      includePlaneswalkers: true;
      cost?: { perCounterOnCreature: true };
    }
  /**
   * "Each player may attack only the nearest opponent in the chosen direction and planeswalkers
   * controlled by that opponent" (Pramikon, Sky Rampart): the direction is the source's chosen
   * option, `left` or `right`, made as it entered. It applies to every player, the source's
   * controller included, and several such statics intersect.
   */
  | { kind: 'attackOnlyNearestOpponent' }
  /**
   * "If a creature an opponent controls attacks, all creatures that opponent controls attack if
   * able" (War's Toll): a requirement on the whole declaration of each opponent of the source's
   * controller. Either nothing attacks or every creature that can attack without paying a cost
   * does (CR 508.1d); declaring no attack at all stays legal.
   */
  | { kind: 'opponentsAttackWithAll' }
  /**
   * "This creature can't attack alone" / "can't block alone" (Toby's Beast token). The creature
   * is this permanent itself. Attacking alone means being the only creature declared as an
   * attacker; blocking alone means being the only creature its controller declares as a blocker
   * (CR 506.5). Such a creature may be declared only together with another one.
   */
  | { kind: 'cantAttackAlone' }
  | { kind: 'cantBlockAlone' }
  /**
   * "~ attacks an opponent with the most life among your opponents each combat if able, unless
   * <condition>" (Galactus): a requirement of THIS creature, lost with its abilities. Attacking a
   * player with the most life among its controller's opponents (any of them, on a tie) obeys it;
   * a planeswalker never does. It is read as attackers are declared and does not apply while
   * `unless` holds.
   */
  | { kind: 'attackRequirement'; target: 'opponentWithMostLife'; unless?: Condition }
  /**
   * "This creature can't be blocked except by N or more creatures" (Hexmark Destroyer). The
   * attacker is this permanent itself. Either none block it or at least `minimum` do (CR 509.1b),
   * as menace is the case of two.
   */
  | { kind: 'minBlockers'; minimum: number }
  /**
   * "Creatures with power less than this creature's power can't block creatures you control"
   * (Champion of Lambholt): attackers matching `attackerFilter`, read from this permanent's
   * controller's point of view, can't be blocked by a creature whose power is less than this
   * permanent's CURRENT power. Lost with its abilities; copies have it.
   */
  | { kind: 'cantBlockCreatures'; attackerFilter: Selector; blockerPowerLessThanSource: true }
  /** Opposing spells that target this permanent cost life during announcement. */
  | { kind: 'targetLifeTax'; amount: number }
  | { kind: 'convoke' }
  | { kind: 'improvise' }
  | { kind: 'kicker'; cost?: ParsedManaCost }
  | { kind: 'noMaximumHandSize' }
  | { kind: 'triggerAdditionalOnArtifactOrCreatureEntry' }
  /**
   * Harmonic Prodigy: triggered abilities of Shamans and other Wizards its controller controls
   * trigger one additional time. Multiple permanents with this static each add one copy.
   */
  | { kind: 'triggerAdditionalForShamanOrOtherWizard' }
  /**
   * "If a triggered ability of [another] [filter] you control triggers, it triggers an additional
   * time" (Annie Joins Up, Roaming Throne). `filter` is matched from this permanent's view, so
   * `chosenSubtype` is the type chosen for it; each such permanent adds one more firing.
   */
  | { kind: 'triggerAdditionalTime'; filter: Selector; excludesSelf?: true }
  /**
   * "The 'legend rule' doesn't apply to [filter] you control" (Council of Reeds): CR 704.5j
   * ignores its controller's permanents that match `filter` from this permanent's view.
   */
  | { kind: 'legendRuleDoesntApply'; filter: Selector }
  | { kind: 'artifactTokenCreatesThopter' }
  /**
   * "If you would create a Clue, Food, or Treasure token, instead create one of each" (Academy
   * Manufactor): a replacement on its controller's token creation (CR 614.1a). Each one applies
   * to every token the others made, so two turn one Treasure into three of each.
   */
  | { kind: 'createClueFoodAndTreasure' };
