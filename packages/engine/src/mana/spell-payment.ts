import type { ObjectId } from '@mtg/shared';
import type { AbilityCost } from '../cards/ability';
import type { GameGen } from '../decisions';
import { chooseCard } from '../effects/choose';
import { selectMatches } from '../cards/selector';
import { matchesSelector } from '../effects/continuous';
import { evaluateValueIn } from '../effects/values';
import { allowanceFor, cardZoneCandidate, manaSourcesFor } from '../state/queries';
import type { EnginePlayerState, GameContext } from '../state/types';
import { planPayment } from './cost';
import type { ManaSource, ParsedManaCost, PaymentPlan } from './cost';
import { needsStatefulManaPayment, planStatefulManaPayment } from './stateful-payment';

export interface SpellPaymentRequest {
  /** Already locked total mana cost, including reductions and additional mana costs. */
  mana: ParsedManaCost;
  costs: readonly AbilityCost[];
  sourceCardId: string;
  sourceOracleId: string;
  sourceIsCommander: boolean;
  spellDefinition?: import('../cards/definition').CardDefinition;
  x?: number;
  targetLifeTax?: number;
  energyAlternativeCost?: number;
  sources?: readonly ManaSource[];
}

export interface SpellPaymentChoice {
  costIndex: number;
  ordinal: number;
  kind:
    | 'tapOther'
    | 'sacrificeOther'
    | 'discardCard'
    | 'exileCardFromHand'
    | 'exileOtherCardsFromGraveyard';
  objectId: ObjectId;
}

export interface SpellPaymentWitness {
  lockedCosts: AbilityCost[];
  choices: SpellPaymentChoice[];
  manaPlan: PaymentPlan;
  lifePaid: number;
  reservedObjectIds: Set<ObjectId>;
}

interface ChoiceGroup {
  costIndex: number;
  ordinal: number;
  kind: SpellPaymentChoice['kind'];
  candidates: { id: ObjectId; cardId: string }[];
  resource: 'tap' | 'consume';
}

/**
 * Search one joint witness. Prefix choices narrow the search for later payment menus.
 * Tap resources are distinct from consumed cards: tapping for mana then sacrificing that
 * permanent is legal. A reserved sacrifice cannot be spent by a mana activation itself.
 * Costs unsupported by the spell executor return null rather than pretending to be free.
 */
export function planSpellPayment(
  ctx: GameContext,
  player: EnginePlayerState,
  request: SpellPaymentRequest,
  prefix: readonly SpellPaymentChoice[] = [],
): SpellPaymentWitness | null {
  const source = { cardId: request.sourceCardId, controllerId: player.id };
  const lockedCosts: AbilityCost[] = request.costs.map((cost) =>
    cost.kind === 'payLifeValue'
      ? {
          kind: 'payLife',
          amount: evaluateValueIn(ctx, cost.amount, {
            controllerId: player.id,
            sourceCardId: request.sourceCardId,
            x: request.x ?? 0,
          }),
        }
      : cost,
  );
  let lifePaid = request.targetLifeTax ?? 0;
  if (!Number.isSafeInteger(lifePaid) || lifePaid < 0) return null;
  if (player.energy < (request.energyAlternativeCost ?? 0)) return null;
  const groups: ChoiceGroup[] = [];
  for (const [costIndex, cost] of lockedCosts.entries()) {
    if (cost.kind === 'mana') continue;
    if (cost.kind === 'payLife') {
      if (!Number.isSafeInteger(cost.amount) || cost.amount < 0) return null;
      lifePaid += cost.amount;
      continue;
    }
    let candidates: ChoiceGroup['candidates'];
    let count = 1;
    let kind: ChoiceGroup['kind'];
    let resource: ChoiceGroup['resource'] = 'consume';
    switch (cost.kind) {
      case 'tapOther':
      case 'sacrificeOther':
        kind = cost.kind;
        resource = cost.kind === 'tapOther' ? 'tap' : 'consume';
        count = cost.kind === 'sacrificeOther' ? (cost.count ?? 1) : 1;
        candidates = ctx.state.battlefield.filter(
          (permanent) =>
            permanent.controllerId === player.id &&
            (cost.kind !== 'tapOther' || !permanent.tapped) &&
            matchesSelector(ctx, permanent, cost.selector, source),
        );
        break;
      case 'discardCard':
      case 'exileCardFromHand':
        kind = cost.kind;
        count = cost.count ?? 1;
        candidates = player.hand.filter(
          (card) =>
            card.cardId !== request.sourceCardId &&
            (cost.kind === 'discardCard' ||
              selectMatches(cardZoneCandidate(ctx, card, player.id), cost.selector, source)),
        );
        break;
      case 'exileOtherCardsFromGraveyard':
        kind = cost.kind;
        count = cost.count;
        candidates = player.graveyard.filter((card) => card.cardId !== request.sourceCardId);
        break;
      default:
        return null;
    }
    if (!Number.isSafeInteger(count) || count < 0) return null;
    if (candidates.length < count) return null;
    for (let ordinal = 0; ordinal < count; ordinal++)
      groups.push({ costIndex, ordinal, kind, resource, candidates });
  }
  const statefulMana = needsStatefulManaPayment(ctx, player, request.mana, lifePaid);
  if (!statefulMana && lifePaid > 0 && lifePaid > player.life) return null;
  // The caller cannot smuggle a nonexistent or duplicate assignment through a prefix.
  if (
    prefix.some(
      (choice, index) =>
        !groups.some(
          (group) =>
            group.costIndex === choice.costIndex &&
            group.ordinal === choice.ordinal &&
            group.kind === choice.kind &&
            group.candidates.some((candidate) => candidate.id === choice.objectId),
        ) ||
        prefix
          .slice(0, index)
          .some(
            (earlier) =>
              earlier.costIndex === choice.costIndex && earlier.ordinal === choice.ordinal,
          ),
    )
  )
    return null;
  const sources = request.sources ?? manaSourcesFor(ctx, player.id);
  const taps = new Set<string>();
  const consumed = new Set<string>();
  const choices: SpellPaymentChoice[] = [];
  const allows = allowanceFor(ctx, player.id, {
    kind: 'castSpell',
    oracleId: request.sourceOracleId,
    isCommander: request.sourceIsCommander,
    ...(request.spellDefinition === undefined ? {} : { spellDefinition: request.spellDefinition }),
  });
  function search(index: number): SpellPaymentWitness | null {
    const group = groups[index];
    if (group === undefined) {
      const reserved = new Set(
        ctx.state.battlefield
          .filter((p) => consumed.has(p.cardId) || taps.has(p.cardId))
          .map((p) => p.cardId),
      );
      const usableFrom = (payer: EnginePlayerState, currentSources: readonly ManaSource[]) =>
        currentSources.flatMap((manaSource): ManaSource[] => {
          if (taps.has(manaSource.cardId) && manaSource.costs.some((cost) => cost.kind === 'tap'))
            return [];
          if (
            reserved.has(manaSource.cardId) &&
            manaSource.costs.some(
              (cost) => cost.kind === 'sacrificeSelf' || cost.kind === 'exileSelf',
            )
          )
            return [];
          const sacrifices = manaSource.sacrifices?.map((candidates) =>
            candidates.filter((cardId) => !reserved.has(cardId)),
          );
          if (sacrifices?.some((candidates) => candidates.length === 0)) return [];
          const resources = manaSource.resources?.map((resource) =>
            resource.key === 'energy'
              ? {
                  ...resource,
                  available: Math.min(
                    resource.available,
                    payer.energy - (request.energyAlternativeCost ?? 0),
                  ),
                }
              : resource,
          );
          return [
            {
              ...manaSource,
              ...(sacrifices === undefined ? {} : { sacrifices }),
              ...(resources === undefined ? {} : { resources }),
            },
          ];
        });
      const reservedObjectIds = new Set(
        ctx.state.battlefield.filter((p) => reserved.has(p.cardId)).map((p) => p.id),
      );
      const manaPlan = statefulMana
        ? planStatefulManaPayment(
            ctx,
            player,
            request.mana,
            allows,
            (context, payer) => usableFrom(payer, manaSourcesFor(context, payer.id, true)),
            reservedObjectIds,
            lifePaid,
            request.energyAlternativeCost ?? 0,
          )
        : planPayment(
            request.mana,
            player.manaEntries,
            usableFrom(player, sources),
            allows,
            player.life - lifePaid,
          );
      if (manaPlan === null) return null;
      return {
        lockedCosts,
        choices: [...choices],
        manaPlan,
        lifePaid,
        reservedObjectIds,
      };
    }
    const fixed = prefix.find(
      (choice) => choice.costIndex === group.costIndex && choice.ordinal === group.ordinal,
    );
    const used = group.resource === 'tap' ? taps : consumed;
    for (const candidate of group.candidates) {
      if (used.has(candidate.cardId) || (fixed !== undefined && candidate.id !== fixed.objectId))
        continue;
      used.add(candidate.cardId);
      choices.push({
        costIndex: group.costIndex,
        ordinal: group.ordinal,
        kind: group.kind,
        objectId: candidate.id,
      });
      const witness = search(index + 1);
      choices.pop();
      used.delete(candidate.cardId);
      if (witness !== null) return witness;
    }
    return null;
  }
  return search(0);
}

/** Select cost assignments while every resource is still present, offering only completions. */
export function* chooseSpellPayment(
  ctx: GameContext,
  player: EnginePlayerState,
  request: SpellPaymentRequest,
): GameGen<SpellPaymentWitness> {
  let witness = planSpellPayment(ctx, player, request);
  if (witness === null) throw new Error('spell total cost is not jointly payable');
  const prefix: SpellPaymentChoice[] = [];
  for (const group of witness.choices) {
    const kind = group.kind;
    const pool =
      kind === 'tapOther' || kind === 'sacrificeOther'
        ? ctx.state.battlefield
        : kind === 'exileOtherCardsFromGraveyard'
          ? player.graveyard
          : player.hand;
    const candidates = pool.filter(
      (card) =>
        planSpellPayment(ctx, player, request, [...prefix, { ...group, objectId: card.id }]) !==
        null,
    );
    // Exactly as many candidates as sacrifices this cost still owes: every one goes, so there is
    // nothing to choose (Dread Return's flashback with exactly three creatures).
    const owed = witness.choices.filter(
      (other) =>
        other.costIndex === group.costIndex &&
        !prefix.some(
          (made) => made.costIndex === other.costIndex && made.ordinal === other.ordinal,
        ),
    ).length;
    if (kind === 'sacrificeOther' && candidates.length === owed && candidates[0] !== undefined) {
      prefix.push({ ...group, objectId: candidates[0].id });
      continue;
    }
    const verb =
      kind === 'tapOther'
        ? 'Tap'
        : kind === 'sacrificeOther'
          ? 'Sacrifice'
          : kind === 'discardCard'
            ? 'Discard'
            : 'Exile';
    const chosen = yield* chooseCard(ctx, {
      player: player.id,
      prompt: `${player.id}: choose a card to ${verb.toLowerCase()} as a spell cost.`,
      cards: candidates,
      type: kind === 'tapOther' ? 'tapCost' : verb.toLowerCase(),
      verb,
    });
    if (chosen === null) throw new Error('invalid prepared spell cost choice');
    prefix.push({ ...group, objectId: chosen.id });
  }
  witness = planSpellPayment(ctx, player, request, prefix);
  if (witness === null) throw new Error('prepared spell cost became unpayable before payment');
  return witness;
}
