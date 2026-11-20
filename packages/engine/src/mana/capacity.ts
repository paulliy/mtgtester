import type { ManaAbilitySpec } from '../cards/ability';
import { battlefieldCharacteristics } from '../effects/continuous';
import { gatherRuleStatics } from '../state/queries';
import type { EnginePlayerState, GameContext } from '../state/types';
import { characteristicsFixedDuringPayment, definitionsInPlay } from './payment-stability';

/**
 * Whether a mana ability's production is a fixed count that one activation pays out at most once:
 * printed units, no state-derived amount or symbols, no activation condition, a `{T}` in its cost
 * and nothing else but mana, and riders that only gain life or deal damage. The same premise as
 * the stateful planner's capacity bound (`planStatefulManaPayment`): no such activation can enable
 * another source or raise what one makes.
 */
function fixedCountAbility(ability: ManaAbilitySpec): boolean {
  return (
    ability.dynamic === undefined &&
    ability.amount === undefined &&
    ability.conditionalUnits === undefined &&
    ability.condition === undefined &&
    (ability.costs === undefined ||
      (ability.costs.some((cost) => cost.kind === 'tap') &&
        ability.costs.every((cost) => cost.kind === 'tap' || cost.kind === 'mana'))) &&
    (ability.onActivate ?? []).every(
      (effect) => effect.op === 'gainLife' || effect.op === 'damageController',
    )
  );
}

/**
 * An upper bound on the mana `player` can spend on one payment in this state, or null when no
 * cheap bound holds. A priority menu uses it to rule out a spell before it gathers the mana
 * sources of the spell's casting preview and searches for a payment: most priority windows offer
 * only "pass", and almost all of the work in building them was proving that each instant in hand
 * cannot be paid for.
 *
 * The bound is the mana already in the pool plus, for each untapped permanent the player controls,
 * the most units any one of its mana abilities makes, plus the units of each card in hand with a
 * mana ability that works from the hand ("exile this card from your hand: add {R}", once each:
 * the card leaves). It holds only when every mana ability of
 * those permanents, tapped or not, is a fixed-count `{T}` ability and no static adds mana to an
 * activation (`manaActivationRider`): then each permanent pays out at most once per payment, a
 * tapped one never, and no activation changes another's production. Colors, restrictions,
 * summoning sickness and activation mana costs are ignored, which can only overestimate. It also
 * needs every static in play to leave characteristics as they are while a payment taps
 * (`characteristicsFixedDuringPayment`): "while this is untapped, lands you control lose all
 * abilities" hides mana that tapping it gives back. Anything else returns null, and the caller
 * does the full check.
 */
export function fixedManaCapacity(ctx: GameContext, player: EnginePlayerState): number | null {
  if (gatherRuleStatics(ctx).some((entry) => entry.static.kind === 'manaActivationRider'))
    return null;
  if (!characteristicsFixedDuringPayment(definitionsInPlay(ctx))) return null;
  const charsOf = battlefieldCharacteristics(ctx);
  let capacity = player.manaEntries.length;
  for (const permanent of ctx.state.battlefield) {
    if (permanent.controllerId !== player.id) continue;
    let most = 0;
    for (const ability of charsOf(permanent).manaAbilities) {
      if (!fixedCountAbility(ability)) return null;
      most = Math.max(most, ability.units.length);
    }
    if (!permanent.tapped) capacity += most;
  }
  for (const card of player.hand)
    capacity += ctx.defs.get(card.oracleId)?.handManaAbility?.units.length ?? 0;
  return capacity;
}
