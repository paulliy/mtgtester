/**
 * Named escalation triggers for bot-led tactics (ADR 0044). Each trigger is computed from the
 * seat's `PlayerView`, the legal menu and the bot's ranking, never from an estimate of hidden
 * cards, and each one that fires is logged with its name. `uncertain` is ADR 0039's close-call
 * rule; `lethal` is shadow-only until its logs show the fixed bot missing kills.
 *
 * Nothing here consumes randomness or changes what is played: shadow evaluation must leave a
 * game's log identical with shadow on or off (ADR 0044 decision 3.1).
 */

import type {
  DecisionRequest,
  DecisionResponse,
  LegalAction,
  PermanentView,
  PlayerView,
} from '@mtg/shared';
import { NO_ATTACK_TARGET, NO_BLOCK_TARGET } from '@mtg/shared';
import {
  combatBody,
  damageThrough,
  incomingDamage,
  readyAttackers,
  untappedCreatures,
  type CardKnowledge,
  type CardTraits,
  type ScoredAction,
} from '@mtg/bot';
import {
  LIVE_ESCALATION_TRIGGERS,
  type EscalationTrigger,
  type LiveEscalationTrigger,
} from './config';

export interface TriggerInput {
  request: DecisionRequest;
  view: PlayerView;
  /** What will be (or was) played. */
  response: DecisionResponse;
  /** The bot's ranking, best first; empty when unscored. */
  ranked: readonly ScoredAction[];
  knowledge: CardKnowledge;
  margin: number;
  /**
   * Whether this opposing stack object is new to the seat, recording it when it is: an unknown
   * spell to answer fires `unknown-card` once, not at every priority it sits on the stack.
   */
  firstSightOf?: (stackObjectId: string) => boolean;
  /** ADR 0039's close-call rule, injected to keep one definition. */
  isUncertain: (
    request: DecisionRequest,
    ranked: readonly ScoredAction[],
    margin: number,
  ) => boolean;
}

const PASSES: ReadonlySet<string> = new Set(['pass', 'passAndYieldTurn', 'yieldToAbility']);

/** Every trigger that fires on this decision, in attribution order. */
export function firedTriggers(input: TriggerInput): EscalationTrigger[] {
  const fired: EscalationTrigger[] = [];
  if (scarceAnswer(input)) fired.push('scarce-answer');
  if (unknownCard(input)) fired.push('unknown-card');
  if (input.isUncertain(input.request, input.ranked, input.margin)) fired.push('uncertain');
  if (lethalNeglected(input)) fired.push('lethal');
  return fired;
}

/** The live trigger a call is attributed to: the first of scarce-answer, unknown-card, uncertain. */
export function attribute(
  fired: readonly EscalationTrigger[],
  live: readonly LiveEscalationTrigger[],
): LiveEscalationTrigger | null {
  for (const trigger of LIVE_ESCALATION_TRIGGERS)
    if (fired.includes(trigger) && live.includes(trigger)) return trigger;
  return null;
}

function chosenAction(input: TriggerInput): LegalAction | undefined {
  return input.request.legalActions.find((action) => action.id === input.response.actionId);
}

function sourceName(action: LegalAction, view: PlayerView): string | undefined {
  const data = action.data?.['sourceName'];
  if (typeof data === 'string') return data;
  if (action.interaction?.kind === 'source') {
    const id = action.interaction.sourceId;
    return (
      view.battlefield.find((p) => p.id === id)?.name ?? view.hand.find((c) => c.id === id)?.name
    );
  }
  return undefined;
}

function sourceId(action: LegalAction): string | undefined {
  return action.interaction?.kind === 'source' ? action.interaction.sourceId : undefined;
}

/** The answer roles that make a card scarce when it is the last of its kind in hand. */
type AnswerKind = 'counter' | 'wipe' | 'hardRemoval';

function answerKinds(traits: CardTraits | undefined): AnswerKind[] {
  if (traits === undefined) return [];
  const kinds: AnswerKind[] = [];
  if (traits.roles.includes('counter')) kinds.push('counter');
  if (traits.roles.includes('wipe')) kinds.push('wipe');
  if (traits.roles.includes('removal') && traits.hardRemoval === true) kinds.push('hardRemoval');
  return kinds;
}

/**
 * `scarce-answer`: at `priority`, the bot would cast a counterspell, board wipe, or destroy or
 * exile removal; no other card in the seat's hand has that role; and the public board shows no
 * lethal at stake (ADR 0044 decision 1).
 */
function scarceAnswer(input: TriggerInput): boolean {
  const { request, view, knowledge } = input;
  if (request.decisionType !== 'priority') return false;
  const action = chosenAction(input);
  if (action?.type !== 'castSpell') return false;
  const kinds = answerKinds(knowledge(sourceName(action, view) ?? ''));
  if (kinds.length === 0) return false;
  const id = sourceId(action);
  const others = view.hand.filter((card) => card.id !== id);
  const last = kinds.some(
    (kind) => !others.some((card) => answerKinds(knowledge(card.name)).includes(kind)),
  );
  return last && !publicLethal(view, request, knowledge);
}

/** A noncreature, nonland card the classifier cannot account for, or does not know at all. */
function unclassifiedSpell(name: string | undefined, knowledge: CardKnowledge): boolean {
  if (name === undefined) return false;
  const traits = knowledge(name);
  if (traits === undefined) return true;
  if (traits.types.includes('Creature') || traits.types.includes('Land')) return false;
  return traits.unclassified === true;
}

/**
 * `unknown-card`: at `priority` or `chooseTargets`, the spell or ability the bot would use, or the
 * opponent's spell it must respond to, comes from an unclassified noncreature, nonland card.
 *
 * Limits: the bot's own spell is seen when it is chosen at `priority` (by `chooseTargets` it was
 * already chosen there); an ability on the stack shows a description, not a card name, so only
 * spells are looked up; an opposing spell fires once per stack object, not at every priority.
 */
function unknownCard(input: TriggerInput): boolean {
  const { request, view, knowledge } = input;
  if (request.decisionType !== 'priority' && request.decisionType !== 'chooseTargets') return false;
  const action = chosenAction(input);
  if (
    action !== undefined &&
    (action.type === 'castSpell' || action.type === 'activateAbility') &&
    unclassifiedSpell(sourceName(action, view), knowledge)
  )
    return true;
  const top = view.stack.at(-1);
  if (top === undefined || top.controller === view.seat) return false;
  // A spell is shown by its card name; an ability's description is not a card name and is not
  // looked up, so an unknown ability on the stack does not fire the trigger.
  if (knowledge(top.description) === undefined || !unclassifiedSpell(top.description, knowledge))
    return false;
  return input.firstSightOf?.(top.id) ?? true;
}

// --- lethal --------------------------------------------------------------------------------------

/** Constant damage the seat's hand could send at a player: burn spells whose slots deal it. */
function burnInHand(view: PlayerView, knowledge: CardKnowledge): number {
  let total = 0;
  for (const card of view.hand) {
    const traits = knowledge(card.name);
    if (traits === undefined || !traits.roles.includes('burn')) continue;
    const best = Math.max(0, ...(traits.spellDamage ?? []).map((d) => d ?? 0));
    total += best;
  }
  return total;
}

/** The opponents this seat could kill this turn from its board and the cards it can see. */
export function offensiveLethal(
  view: PlayerView,
  request: DecisionRequest,
  knowledge: CardKnowledge,
) {
  if (request.activePlayer !== view.seat) return [];
  const combatOver = request.phase === 'postcombatMain' || request.phase === 'ending';
  const attackers = combatOver ? [] : readyAttackers(view).map((p) => combatBody(p));
  const burn = burnInHand(view, knowledge);
  return view.opponents.filter((o) => {
    if (o.life <= 0) return false;
    const blockers = untappedCreatures(view, o.seat).map((p) => combatBody(p));
    return damageThrough(attackers, blockers) + burn >= o.life;
  });
}

/**
 * The power each opponent's creatures add from a team pump that opponent has on the stack: the
 * stack is public, so a resolving Overrun is part of the board a seat can read.
 */
function stackPumps(view: PlayerView, knowledge: CardKnowledge): Map<string, number> {
  const pumps = new Map<string, number>();
  for (const item of view.stack) {
    if (item.controller === view.seat) continue;
    const pump = knowledge(item.description)?.massPump;
    if (pump !== undefined)
      pumps.set(item.controller, (pumps.get(item.controller) ?? 0) + pump.power);
  }
  return pumps;
}

/**
 * Whether the opponents who act before this seat's next turn have lethal on board: their total
 * creature power (plus team pumps they have on the stack) reaches the seat's life, an opponent's
 * commander damage plus its biggest creature reaches 21, or infect and toxic power reaches ten
 * poison counters.
 */
export function defensiveLethal(view: PlayerView, knowledge: CardKnowledge): boolean {
  const live = new Set(view.opponents.filter((o) => o.life > 0).map((o) => o.seat));
  const pumps = stackPumps(view, knowledge);
  const theirs = view.battlefield.filter(
    (p) => live.has(p.controller) && p.power !== undefined && p.power !== null,
  );
  const powerOf = (p: (typeof theirs)[number]): number =>
    Math.max(0, (p.power ?? 0) + (pumps.get(p.controller) ?? 0));
  const power = theirs.reduce((sum, p) => sum + powerOf(p), 0);
  if (power >= view.life) return true;
  for (const opponent of view.opponents) {
    if (!live.has(opponent.seat) || opponent.commanderDamageDealtToYou === 0) continue;
    const biggest = Math.max(
      0,
      ...theirs.filter((p) => p.controller === opponent.seat).map(powerOf),
    );
    if (opponent.commanderDamageDealtToYou + biggest >= 21) return true;
  }
  const poisonous = theirs
    .filter((p) => (p.keywords ?? []).some((k) => /^(infect|toxic)/i.test(k)))
    .reduce((sum, p) => sum + powerOf(p), 0);
  return poisonous > 0 && (view.poisonCounters ?? 0) + poisonous >= 10;
}

/** Lethal at stake on the public board, either way (ADR 0044's `scarce-answer` exemption). */
function publicLethal(
  view: PlayerView,
  request: DecisionRequest,
  knowledge: CardKnowledge,
): boolean {
  return (
    incomingTotal(view) >= view.life ||
    defensiveLethal(view, knowledge) ||
    offensiveLethal(view, request, knowledge).length > 0
  );
}

function incomingTotal(view: PlayerView): number {
  return [...incomingDamage(view).values()].reduce((sum, d) => sum + d, 0);
}

/** Whether the creatures this attack leaves home (and vigilant attackers) hold off the swing. */
function attackKeepsSafe(
  view: PlayerView,
  action: LegalAction,
  response: DecisionResponse,
  knowledge: CardKnowledge,
): boolean {
  const subjects = (action.data?.['subjects'] as Array<{ subjectId?: string }> | undefined) ?? [];
  const sent = new Set(
    (response.targets ?? []).flatMap((choice, i) =>
      choice.choice === NO_ATTACK_TARGET ? [] : [subjects[i]?.subjectId ?? ''],
    ),
  );
  const kept = untappedCreatures(view, view.seat)
    .filter((p) => !sent.has(p.id) || (p.keywords ?? []).some((k) => /^vigilance$/i.test(k)))
    .map((p) => combatBody(p));
  const pumps = stackPumps(view, knowledge);
  const threats = view.battlefield
    .filter(
      (p) =>
        p.controller !== view.seat &&
        p.power !== undefined &&
        p.power !== null &&
        view.opponents.some((o) => o.seat === p.controller && o.life > 0),
    )
    .map((p) => combatBody(p, { power: pumps.get(p.controller) ?? 0, toughness: 0 }));
  return damageThrough(threats, kept) < view.life;
}

/**
 * Combat damage to this seat once the proposed blocks are applied. Each slot is one blocker
 * (`data.subjects[i]`) and its choice the attacker it blocks. An unblocked attacker deals its
 * power; a blocked one deals nothing unless it has trample, which assigns lethal damage to its
 * blockers and the rest to this seat (CR 702.19b). Lethal damage is each blocker's toughness, or
 * 1 from a deathtouch attacker (CR 702.2c). First strike and tricks are not modelled.
 */
function damageThroughBlocks(view: PlayerView, action: LegalAction, response: DecisionResponse) {
  const subjects = (action.data?.['subjects'] as Array<{ subjectId?: string }> | undefined) ?? [];
  const byId = new Map(view.battlefield.map((p) => [p.id, p]));
  const blockersOf = new Map<string, PermanentView[]>();
  (response.targets ?? []).forEach((choice) => {
    if (choice.choice === NO_BLOCK_TARGET) return;
    const blocker = byId.get(subjects[choice.slot]?.subjectId ?? '');
    if (blocker === undefined) return;
    blockersOf.set(choice.choice, [...(blockersOf.get(choice.choice) ?? []), blocker]);
  });
  let through = 0;
  for (const attacker of view.battlefield) {
    if (attacker.attacking !== view.seat || attacker.attackingPlaneswalker !== undefined) continue;
    const power = Math.max(0, attacker.power ?? 0);
    const blockers = blockersOf.get(attacker.id) ?? [];
    if (blockers.length === 0) {
      through += power;
      continue;
    }
    const keywords = new Set((attacker.keywords ?? []).map((k) => k.toLowerCase()));
    if (!keywords.has('trample')) continue;
    const lethal = blockers.reduce(
      (sum, b) => sum + (keywords.has('deathtouch') ? 1 : Math.max(0, b.toughness ?? 0)),
      0,
    );
    through += Math.max(0, power - lethal);
  }
  return through;
}

/**
 * `lethal` (shadow only): public lethal exists and the bot's line neither takes nor prevents it.
 * Counted where the line can be read from one decision: passing (or yielding) on this seat's turn
 * before combat damage while an opponent is killable; an attack that sends no killable opponent
 * its lethal; passing while the attack on this seat is lethal as blocks stand; and blocks that
 * leave lethal unblocked.
 */
function lethalNeglected(input: TriggerInput): boolean {
  const { request, view, response, knowledge } = input;
  const action = chosenAction(input);
  if (action === undefined) return false;
  if (request.decisionType === 'priority') {
    if (!PASSES.has(action.type)) return false;
    if (request.activePlayer === view.seat) {
      const beforeDamage = request.phase !== 'postcombatMain' && request.phase !== 'ending';
      return beforeDamage && offensiveLethal(view, request, knowledge).length > 0;
    }
    return incomingTotal(view) >= view.life;
  }
  if (action.type === 'attackDeclaration') {
    // An attack that keeps enough blockers home prevents the defensive lethal; one that does not
    // leaves it standing, which is the line neglecting it.
    if (defensiveLethal(view, knowledge) && !attackKeepsSafe(view, action, response, knowledge))
      return true;
    const killable = offensiveLethal(view, request, knowledge);
    if (killable.length === 0) return false;
    // Declining a kill to keep blockers home is a line, not a neglect.
    if (defensiveLethal(view, knowledge)) return false;
    const byId = new Map(view.battlefield.map((p) => [p.id, p]));
    const subjects = (action.data?.['subjects'] as Array<{ subjectId?: string }> | undefined) ?? [];
    return !killable.some((opponent) => {
      const sent = (response.targets ?? []).flatMap((choice, i) => {
        if (choice.choice === NO_ATTACK_TARGET || choice.choice !== opponent.seat) return [];
        const p = byId.get(subjects[i]?.subjectId ?? '');
        return p === undefined ? [] : [combatBody(p)];
      });
      const blockers = untappedCreatures(view, opponent.seat).map((p) => combatBody(p));
      return damageThrough(sent, blockers) >= opponent.life;
    });
  }
  if (action.type === 'blockDeclaration') {
    // Someone else choosing this seat's blocks (Master Warcraft) answers from their own view, so
    // the life and attackers here are not the defender's: nothing to judge.
    if (action.data?.['blockingPlayer'] !== undefined) return false;
    const incoming = incomingDamage(view);
    const total = [...incoming.values()].reduce((sum, d) => sum + d, 0);
    if (total < view.life) return false;
    return damageThroughBlocks(view, action, response) >= view.life;
  }
  return false;
}
