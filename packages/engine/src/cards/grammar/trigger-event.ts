/**
 * Trigger-event phrases for the card grammar (ADR 0038): the head of a triggered ability ("When
 * ~ enters", "Whenever you cast a noncreature spell", "At the beginning of your upkeep"), parsed
 * to the `TriggerHead`s it fires on and the rest of the line. A head this module does not know
 * returns null, and null leaves the card unmodeled.
 */

import type { OracleCard } from '@mtg/shared';
import { SELF_SUBJECT } from '../ability';
import type { ObjectTriggerWhen, TriggerHead, TriggerSubject } from '../ability';
import { CARD_TYPE_SINGULARS } from './words';
import { ANY_SPELL, parseSpellFilter, parseSubject, parseTriggerSubject } from './subject';
import { parseConditionClause } from './condition';
import type { Condition } from '../condition';
import {
  IS_COMMANDER,
  IS_TOKEN,
  OPPONENTS,
  OTHER,
  SELF,
  YOURS,
  allOf,
  anyOf,
  not,
  ofType,
} from '../selector';
import { noteSlotFailure } from './diagnostics';

/**
 * "When ~ enters" / "Whenever a Dragon you control attacks" — one shape covering both, because
 * they are the same event seen from two vantage points (see `TriggerSubject`).
 */
export const OBJECT_TRIGGER_HEAD_RE =
  /^when(?:ever)? (.+?) (enters from (?:a|your) graveyard|enters or leaves the battlefield|enters(?: the battlefield)?(?: or attacks| or transforms into ~)?|transforms into ~|leaves the battlefield|is put into a graveyard from the battlefield or is put into exile from the battlefield|is put into a graveyard from the battlefield|dies or is put into exile from the battlefield|dies|attacks alone|attacks|becomes tapped|becomes crewed|is turned face up|deals combat damage to a player), (.*)$/;

export const STEP_TRIGGER_HEAD_RE =
  /^at the beginning of (your|each(?: player's)?) (upkeep|end step|combat|first main phase|precombat main phase), (.*)$/;

/**
 * "Whenever **one or more** Dragons you control attack" — the aggregate form (CR 603.2c). The
 * plural subject is stripped back to its singular here so `parseTriggerSubject` sees the same
 * phrase it would in the ordinary form; the aggregation is a flag on the head, not a different
 * selector.
 */
export const AGGREGATE_TRIGGER_HEAD_RE =
  /^whenever (?:(~) and\/or )?one or more (.+?) (attack|enter|deals? combat damage to a player), (.*)$/;

/**
 * "Whenever you cast a Dragon spell" (CR 603.2) / "Whenever you cast OR COPY an instant or
 * sorcery spell" (Archmage Emeritus, Storm-Kiln Artist) — the "or copy" half is read onto the
 * same `castsSpell` trigger head rather than added as a real copy-event (the engine has none),
 * an intentionally under-permissive reading (ADR 0010): the ability fires correctly whenever the
 * spell is actually CAST, only silently missing the strictly rarer copy case, rather than being
 * left unmodeled over one clause it cannot fully honor.
 */
export const TOKEN_CREATED_TRIGGER_HEAD_RE =
  /^whenever (you|a player|an opponent) create(?:s)? ((?:one or more |a )?(?:creature )?tokens?), (.*)$/;

// English verb agreement makes the second person a separate surface form: cards print
// "Whenever YOU DRAW YOUR second card" but "Whenever an opponent DRAWS THEIR second card".
// `draws?` plus an either-possessive keeps one regex over both rather than two that drift.
export const DRAW_COUNT_TRIGGER_HEAD_RE =
  /^whenever (you|a player|an opponent) draws? (?:their|your) (second|third|fourth|fifth|sixth) card each turn, (.*)$/;

/** "Whenever you foretell a card" (Dream Devourer): the foretell special action (CR 702.143c). */
export const FORETELL_TRIGGER_HEAD_RE = /^whenever you foretell a card, (.*)$/;

export const DRAW_TRIGGER_HEAD_RE =
  /^whenever (you|a player|an opponent) draws? (?:a|one) card, (.*)$/;

export const DRAW_EXCEPT_FIRST_TRIGGER_HEAD_RE =
  /^whenever (you|a player|an opponent) draws? a card except the first one they draw in each of their draw steps, (.*)$/;

export const SACRIFICE_TRIGGER_HEAD_RE =
  /^whenever (you|a player|an opponent) sacrifices? (.+?), (.*)$/;

export const TOKEN_OR_SACRIFICE_TRIGGER_HEAD_RE =
  /^whenever (you|a player|an opponent) create(?:s)? or sacrifice(?:s)? (?:a )?tokens?, (.*)$/;

export const GRAVEYARD_CROSSING_TRIGGER_HEAD_RE =
  /^whenever another creature dies, or a creature card is put into a graveyard from anywhere other than the battlefield, or a creature card leaves your graveyard, (.*)$/;

export const ORDINAL_CAST_TRIGGER_HEAD_RE =
  /^whenever (you|an opponent) casts? (?:your|their) (first|second|third|fourth|fifth|sixth) (.+?) each turn, (.*)$/;

export const CAST_TRIGGER_HEAD_RE =
  /^whenever (you|an opponent|a player) casts?(?: or copy)? (.+?), (.*)$/;

/**
 * Self-reference in a trigger head. `~` is the substituted card name; the "this <type>" forms
 * appear here in LOWERCASE ("When this enchantment enters"), so `SELF_REFERENCE_RE` — which is
 * deliberately case-sensitive, to leave mid-sentence back-references alone — does not catch
 * them. In a trigger head the ambiguity it guards against cannot arise: nothing precedes the
 * subject for "this" to refer back to.
 */
export const SELF_TRIGGER_SUBJECT_RE =
  /^(?:~|this (?:creature|artifact|enchantment|land|permanent|token|vehicle|equipment|saga|planeswalker|aura))$/;

/** A trigger head as `parseTriggerHead` reads it: the events, and the line after the head. */
export interface ParsedTriggerHead {
  heads: TriggerHead[];
  body: string;
  /** A condition the head itself implies ("attacks while …"), checked like an intervening-if. */
  implicitCondition: Condition | undefined;
  /** A condition on the triggering event, checked when the event happens. */
  eventCondition: Condition | undefined;
}

/**
 * Read the head of a trigger line (its first line, lowercased, with the card's name as `~`).
 * Null means the head is not one the grammar knows, which leaves the card unmodeled.
 */
function parseTriggerHeadUntraced(firstLine: string, card: OracleCard): ParsedTriggerHead | null {
  let heads: TriggerHead[];
  let body: string;
  let implicitCondition: Condition | undefined;
  let eventCondition: Condition | undefined;
  const enterAndCast = firstLine.match(
    /^when (.+?) enters and whenever (you|an opponent|a player) casts? (.+?), (.*)$/,
  );
  const becomesTargeted = firstLine.match(
    /^whenever (.+?) becomes the target of a spell or ability an opponent controls, (.*)$/,
  );
  const attacksWhile = firstLine.match(/^whenever (.+?) attacks while (.+?), (.*)$/);
  const attacksPlayerWithMoreLife = firstLine.match(
    /^whenever (.+?) attacks a player who has more life than you, (.*)$/,
  );
  const step = firstLine.match(STEP_TRIGGER_HEAD_RE);
  const combatOnTurn = firstLine.match(
    /^at the beginning of combat on (your|each(?: player's)?) turn, (.*)$/,
  );
  const attackEachOpponent = firstLine.match(
    /^whenever you attack( with (?:this creature|~) and\/or your commander)?, for each opponent, (.*)$/,
  );
  const aggregate = firstLine.match(AGGREGATE_TRIGGER_HEAD_RE);
  const ordinalCast = firstLine.match(ORDINAL_CAST_TRIGGER_HEAD_RE);
  const cast = firstLine.match(CAST_TRIGGER_HEAD_RE);
  const tokenCreated = firstLine.match(TOKEN_CREATED_TRIGGER_HEAD_RE);
  const tokenOrSacrifice = firstLine.match(TOKEN_OR_SACRIFICE_TRIGGER_HEAD_RE);
  const sacrifice = firstLine.match(SACRIFICE_TRIGGER_HEAD_RE);
  const drawCount = firstLine.match(DRAW_COUNT_TRIGGER_HEAD_RE);
  const drawExceptFirst = firstLine.match(DRAW_EXCEPT_FIRST_TRIGGER_HEAD_RE);
  const draw = firstLine.match(DRAW_TRIGGER_HEAD_RE);
  const foretell = firstLine.match(FORETELL_TRIGGER_HEAD_RE);
  const graveyardCrossing = firstLine.match(GRAVEYARD_CROSSING_TRIGGER_HEAD_RE);
  // "Whenever one or more artifact cards leave your graveyard" (Imotekh the Stormlord): one
  // aggregate event per batch of cards leaving (CR 603.2c); a card is in its owner's graveyard,
  // so "your" is the card's owner.
  const leaveGraveyard = firstLine.match(
    /^whenever (one or more|an?) (artifact|creature|land|enchantment) cards? leaves? your graveyard, (.*)$/,
  );
  // "Whenever one or more +1/+1 counters are put on this creature" (Pensive Professor): one
  // event per placement, entering with counters included (CR 122.6).
  const countersPutOnSelf = firstLine.match(
    /^whenever one or more ([+-]\d+\/[+-]\d+|[a-z]+) counters are put on (?:~|this creature), (.*)$/,
  );
  // "Whenever you put a counter on a creature you control" (Mikey & Leo): any kind, placed by
  // you (CR 122.6a: an entering permanent's counters are put on it by its controller).
  const countersPutByYou = firstLine.match(
    /^whenever you put (?:a|one or more) counters? on (.+?), (.*)$/,
  );
  if (countersPutByYou !== null) {
    const selector = parseTriggerSubject(countersPutByYou[1] as string, card);
    if (selector === null) return null;
    heads = [{ when: 'countersPut', subject: { kind: 'permanent', selector }, byYou: true }];
    body = countersPutByYou[2] as string;
  } else if (countersPutOnSelf !== null) {
    heads = [
      { when: 'countersPut', subject: SELF_SUBJECT, counter: countersPutOnSelf[1] as string },
    ];
    body = countersPutOnSelf[2] as string;
  } else if (enterAndCast !== null) {
    const subjectPhrase = enterAndCast[1] as string;
    let subject: TriggerSubject;
    if (SELF_TRIGGER_SUBJECT_RE.test(subjectPhrase)) {
      subject = SELF_SUBJECT;
    } else {
      const selector = parseTriggerSubject(subjectPhrase, card);
      if (selector === null) return null;
      subject = { kind: 'permanent', selector };
    }
    const filter = parseSpellFilter(enterAndCast[3] as string, card);
    if (filter === null) return null;
    heads = [
      { when: 'enters', subject },
      {
        when: 'castsSpell',
        caster:
          enterAndCast[2] === 'you'
            ? 'you'
            : enterAndCast[2] === 'an opponent'
              ? 'opponent'
              : 'each',
        ...(filter === ANY_SPELL ? {} : { filter }),
      },
    ];
    body = enterAndCast[4] as string;
  } else if (
    becomesTargeted !== null ||
    attacksWhile !== null ||
    attacksPlayerWithMoreLife !== null
  ) {
    const match = becomesTargeted ?? attacksWhile ?? attacksPlayerWithMoreLife;
    if (match === null) return null;
    const subjectPhrase = match[1] as string;
    let subject: TriggerSubject;
    if (SELF_TRIGGER_SUBJECT_RE.test(subjectPhrase)) {
      subject = SELF_SUBJECT;
    } else {
      const selector = parseTriggerSubject(subjectPhrase, card);
      if (selector === null) return null;
      subject = { kind: 'permanent', selector };
    }
    heads = [
      {
        when: becomesTargeted !== null ? 'becomesTargeted' : 'attacks',
        subject,
      },
    ];
    if (attacksWhile !== null) {
      const parsed = parseConditionClause(attacksWhile[2] as string, card);
      if (parsed === null) return null;
      eventCondition = parsed;
      body = attacksWhile[3] as string;
    } else if (attacksPlayerWithMoreLife !== null) {
      eventCondition = { kind: 'attackingPlayerHasMoreLifeThanYou' };
      // "That player" in the effect refers to the attacked player, not the attacker.
      heads = heads.map((head) => ({ ...head, defendingPlayerIsEventPlayer: true as const }));
      body = attacksPlayerWithMoreLife[2] as string;
    } else {
      body = match[2] as string;
    }
  } else if (leaveGraveyard !== null) {
    const type = CARD_TYPE_SINGULARS[leaveGraveyard[2] as string] as string;
    heads = [
      {
        when: 'leavesGraveyard',
        subject: { kind: 'permanent', selector: allOf(ofType(type), YOURS) },
        ...(leaveGraveyard[1] === 'one or more' ? { aggregate: true } : {}),
      },
    ];
    body = leaveGraveyard[3] as string;
  } else if (graveyardCrossing !== null) {
    heads = [
      {
        when: 'dies',
        subject: { kind: 'permanent', selector: allOf(ofType('Creature'), OTHER) },
      },
      {
        when: 'putIntoGraveyardFromAnywhere',
        subject: { kind: 'permanent', selector: allOf(ofType('Creature'), not(IS_TOKEN)) },
      },
      {
        when: 'leavesGraveyard',
        subject: {
          kind: 'permanent',
          selector: allOf(ofType('Creature'), not(IS_TOKEN), YOURS),
        },
      },
    ];
    body = graveyardCrossing[1] as string;
  } else if (tokenOrSacrifice !== null) {
    const relation =
      tokenOrSacrifice[1] === 'you'
        ? YOURS
        : tokenOrSacrifice[1] === 'an opponent'
          ? OPPONENTS
          : undefined;
    const selector = relation === undefined ? IS_TOKEN : allOf(IS_TOKEN, relation);
    heads = [
      { when: 'tokenCreated', subject: { kind: 'permanent', selector } },
      { when: 'sacrificed', subject: { kind: 'permanent', selector } },
    ];
    body = tokenOrSacrifice[2] as string;
  } else if (sacrifice !== null) {
    const relation =
      sacrifice[1] === 'you' ? YOURS : sacrifice[1] === 'an opponent' ? OPPONENTS : undefined;
    const phrase = sacrifice[2] as string;
    let selector =
      phrase === 'a permanent' || phrase === 'permanent'
        ? allOf()
        : parseTriggerSubject(phrase, card);
    if (selector === null) return null;
    if (relation !== undefined) selector = allOf(selector, relation);
    heads = [{ when: 'sacrificed', subject: { kind: 'permanent', selector } }];
    body = sacrifice[3] as string;
  } else if (drawExceptFirst !== null) {
    const playerPhrase = drawExceptFirst[1] as string;
    heads = [
      {
        when: 'drawsCard',
        player:
          playerPhrase === 'you' ? 'you' : playerPhrase === 'an opponent' ? 'opponent' : 'each',
      },
    ];
    implicitCondition = { kind: 'notFirstDrawInOwnDrawStep' };
    body = drawExceptFirst[2] as string;
  } else if (step !== null) {
    heads = [
      {
        when:
          step[2] === 'upkeep'
            ? 'upkeep'
            : step[2] === 'end step'
              ? 'endStep'
              : step[2] === 'combat'
                ? 'beginningOfCombat'
                : 'precombatMain',
        player: step[1] === 'your' ? 'you' : 'each',
      },
    ];
    body = step[3] as string;
  } else if (combatOnTurn !== null) {
    heads = [{ when: 'beginningOfCombat', player: combatOnTurn[1] === 'your' ? 'you' : 'each' }];
    body = combatOnTurn[2] as string;
  } else if (attackEachOpponent !== null) {
    // "Whenever you attack" is the AGGREGATE attack trigger (CR 603.2c over the CR 508.1
    // declaration): it fires once when you declare one or more attackers, whether or not this
    // creature is among them. Reading it as `subject: self` silently narrows Adeline to
    // "whenever Adeline attacks" — she still triggers with a tapped-out Adeline at home.
    // The longer form names its own attackers instead: Ainok Strike Leader fires on this
    // creature AND/OR your commander, so either one attacking is enough.
    const selector =
      attackEachOpponent[1] === undefined
        ? allOf(ofType('Creature'), YOURS)
        : anyOf(SELF, allOf(IS_COMMANDER, YOURS));
    heads = [{ when: 'attacks', subject: { kind: 'permanent', selector }, aggregate: true }];
    body = attackEachOpponent[2] as string;
  } else if (tokenCreated !== null) {
    const relation =
      tokenCreated[1] === 'you' ? YOURS : tokenCreated[1] === 'an opponent' ? OPPONENTS : undefined;
    const tokenSelector =
      tokenCreated[2]?.includes('creature') === true
        ? allOf(IS_TOKEN, ofType('Creature'))
        : IS_TOKEN;
    const selector = relation === undefined ? tokenSelector : allOf(tokenSelector, relation);
    heads = [
      {
        when: 'tokenCreated',
        subject: { kind: 'permanent', selector },
        aggregate: tokenCreated[2]?.startsWith('one or more') === true,
      },
    ];
    body = tokenCreated[3] as string;
  } else if (foretell !== null) {
    heads = [{ when: 'foretells', player: 'you' }];
    body = foretell[1] as string;
  } else if (drawCount !== null || draw !== null) {
    const match = drawCount ?? draw;
    if (match === null) return null;
    const playerPhrase = match[1] as string;
    const player =
      playerPhrase === 'you' ? 'you' : playerPhrase === 'an opponent' ? 'opponent' : 'each';
    heads = [{ when: 'drawsCard', player }];
    if (drawCount !== null) {
      const ordinal = { second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6 }[match[2] as string];
      if (ordinal === undefined) return null;
      // "your SECOND card each turn" fires once, on that draw, and it is part of the event, not
      // an intervening-if (CR 603.4): a later draw before it resolves does not undo it.
      heads = [{ when: 'drawsCard', player, ordinalThisTurn: ordinal }];
      body = match[3] as string;
    } else {
      body = match[2] as string;
    }
  } else if (aggregate !== null) {
    // The subject is plural here ("Dragons you control"), so it reads through `parseSubject`
    // rather than `parseTriggerSubject`.
    const plural = parseSubject(aggregate[2] as string, card);
    if (plural === null) return null;
    // "Whenever Satoru and/or one or more other nontoken creatures you control enter" — the
    // source itself joins the same aggregate event.
    const selector = aggregate[1] === undefined ? plural : anyOf(SELF, plural);
    heads = [
      {
        when:
          aggregate[3] === 'attack'
            ? 'attacks'
            : aggregate[3] === 'enter'
              ? 'enters'
              : 'dealsCombatDamageToPlayer',
        subject: { kind: 'permanent', selector },
        // "… deal combat damage to a player" fires once for EACH player dealt damage, "that
        // damage" being the damage to that player — the same grouping as Pia Nalaar's override.
        aggregate: (aggregate[3] as string).startsWith('deal') ? 'byEventPlayer' : true,
      },
    ];
    body = aggregate[4] as string;
  } else if (ordinalCast !== null) {
    const filter = parseSpellFilter(ordinalCast[3] as string, card);
    const ordinal = {
      first: 1,
      second: 2,
      third: 3,
      fourth: 4,
      fifth: 5,
      sixth: 6,
    }[ordinalCast[2] as string];
    if (filter === null || ordinal === undefined) return null;
    heads = [
      {
        when: 'castsSpell',
        caster: ordinalCast[1] === 'you' ? 'you' : 'opponent',
        ...(filter === ANY_SPELL ? {} : { filter }),
        ordinal,
      },
    ];
    body = ordinalCast[4] as string;
  } else if (cast !== null) {
    // "… casts a spell from a graveyard" / "from anywhere other than your hand": the origin is a
    // restriction on the cast event, not part of the spell's characteristics.
    const origin = (cast[2] as string).match(
      /^(.+?) from (a graveyard|anywhere other than your hand)$/,
    );
    const filter = parseSpellFilter(
      origin === null ? (cast[2] as string) : (origin[1] as string),
      card,
    );
    if (filter === null) return null;
    heads = [
      {
        when: 'castsSpell',
        caster: cast[1] === 'you' ? 'you' : cast[1] === 'an opponent' ? 'opponent' : 'each',
        ...(filter === ANY_SPELL ? {} : { filter }),
        ...(origin === null
          ? {}
          : {
              castFrom: origin[2] === 'a graveyard' ? ('graveyard' as const) : ('notHand' as const),
            }),
      },
    ];
    body = cast[3] as string;
  } else if (/^whenever enchanted player is attacked, /.test(firstLine)) {
    // Curse of Bounty: the Aura's own event, queued for each Aura attached to a defending player
    // as attackers are declared; the event player is the attacking player.
    heads = [{ when: 'enchantedPlayerAttacked', subject: SELF_SUBJECT }];
    body = firstLine.slice('whenever enchanted player is attacked, '.length);
  } else {
    const m = firstLine.match(OBJECT_TRIGGER_HEAD_RE);
    if (m === null) return null;
    const subjectPhrase = m[1] as string;
    const event = m[2] as string;
    const events: ObjectTriggerWhen[] = event.startsWith('enters')
      ? event === 'enters or leaves the battlefield'
        ? ['enters', 'leavesBattlefield']
        : event.endsWith('or attacks')
          ? ['enters', 'attacks']
          : event.includes('transforms into')
            ? ['enters', 'transformsInto']
            : ['enters']
      : // A BACK face prints the bare form ("When this creature transforms into Awoken Horror"):
        // it only ever exists after the flip, so unlike the front face's "enters or transforms
        // into ~" there is no entry event to pair it with.
        event === 'transforms into ~'
        ? ['transformsInto']
        : event === 'leaves the battlefield' || event.endsWith('from the battlefield')
          ? ['leavesBattlefield']
          : event === 'dies'
            ? ['dies']
            : event === 'attacks' || event === 'attacks alone'
              ? ['attacks']
              : event === 'becomes tapped'
                ? // City of Brass. `becomesTapped` is queued from every tap path already, including
                  // `payAbilityCosts(..., 'tapForMana')` - so tapping the land for mana fires it.
                  ['becomesTapped']
                : event === 'is turned face up'
                  ? // Morph, megamorph, disguise and manifest (CR 708.8); queued by `turnFaceUp`.
                    ['turnedFaceUp']
                  : event === 'becomes crewed'
                    ? // Ghost Ark. Queued only when a crew ability resolves (CR 702.122e), never
                      // from another "becomes an artifact creature" effect.
                      ['becomesCrewed']
                    : ['dealsCombatDamageToPlayer'];
    body = m[3] as string;

    let subject: TriggerSubject;
    if (SELF_TRIGGER_SUBJECT_RE.test(subjectPhrase)) {
      subject = SELF_SUBJECT;
    } else {
      const selector = parseTriggerSubject(subjectPhrase, card);
      if (selector === null) return null;
      subject = { kind: 'permanent', selector };
    }
    // "enters from a graveyard" / "enters from your graveyard" (CR 603.6a): the origin zone is
    // part of the enters event, read off the permanent as it arrives.
    const origin = event.match(/^enters from (a|your) graveyard$/);
    // "is put into a graveyard … or … into exile from the battlefield" / "dies or is put into
    // exile from the battlefield": a leave event narrowed to those destinations.
    // The bare "is put into a graveyard from the battlefield" (Fallen Ideal) is the same leave
    // event narrowed to the graveyard alone — "dies" for a permanent that need not be a creature.
    const leavesTo = event.endsWith('into exile from the battlefield')
      ? (['graveyard', 'exile'] as ('graveyard' | 'exile')[])
      : event === 'is put into a graveyard from the battlefield'
        ? (['graveyard'] as ('graveyard' | 'exile')[])
        : undefined;
    // "attacks alone" (exalted, CR 702.83a): the only creature declared as an attacker (CR 506.5).
    if (event === 'attacks alone') {
      heads = [{ when: 'attacks', subject, alone: true }];
      return { heads, body, implicitCondition, eventCondition };
    }
    heads = events.map((when) =>
      leavesTo !== undefined
        ? { when, subject, leavesTo }
        : origin === null
          ? { when, subject }
          : {
              when,
              subject,
              entersFrom: {
                zone: 'graveyard' as const,
                ...(origin[1] === 'your' ? { graveyardOwner: 'you' as const } : {}),
              },
            },
    );
  }
  return { heads, body, implicitCondition, eventCondition };
}

/** `parseTriggerHeadUntraced`, recording a failure for slot diagnostics (ADR 0038 decision 2). */
export function parseTriggerHead(
  ...args: Parameters<typeof parseTriggerHeadUntraced>
): ReturnType<typeof parseTriggerHeadUntraced> {
  const result = parseTriggerHeadUntraced(...args);
  if (result === null) noteSlotFailure('trigger event', args[0]);
  return result;
}
