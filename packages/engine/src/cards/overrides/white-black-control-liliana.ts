import { ofType } from '../selector';
import { graveyardCardTarget, loyaltyAbility, onBeginCombat, triggered, targetSlots } from '../templates';
import { constant } from '../value';
import type { Value } from '../value';
import { replaceCard } from './index';

export function registerWhiteBlackControlLilianaOverrides(): void {
  const player = targetSlots({ player: { kind: 'player' } });
  const creature = targetSlots({ creature: { kind: 'creature' } });
  const graveyard = targetSlots({ creature: graveyardCardTarget('any', { filter: ofType('Creature') }) });
  replaceCard('0ba134d8-ee7d-48ec-8dc6-57942b8e9261', 'Liliana of the Veil', [
    'unrecognized rules text: "+1: Each player discards a card."',
    'unrecognized rules text: "−2: Target player sacrifices a creature."',
    'unrecognized rules text: "−6: Separate all permanents target player controls into two piles. That player sacrifices all permanents in the pile of their choice."',
  ], { activatedAbilities: [
    loyaltyAbility(1, { effects: [{ op: 'discardEachPlayer', scope: 'all', count: constant(1) }], description: 'Each player discards a card' }),
    loyaltyAbility(-2, { targets: player.targets, effects: [{ op: 'sacrificeTargetPlayerCreature', target: player.slot.player }], description: 'Target player sacrifices a creature' }),
    loyaltyAbility(-6, { targets: player.targets, effects: [{ op: 'separatePermanentsIntoPilesThenSacrifice', target: player.slot.player }], description: 'Separate permanents into piles; their controller chooses a pile to sacrifice' }),
  ] }, 'Uses normal loyalty costs and timing, simultaneous discard choices, and controller/target-player pile decisions.');

  const minusGraveyardSize: Value = { kind: 'negate', of: { kind: 'countCardsInZone', zone: 'graveyard', owner: 'you', selector: { kind: 'allOf', of: [] } } };
  replaceCard('e0df8e2a-96d2-4e4d-b065-aa2e162abbfe', 'Liliana, Waker of the Dead', [
    'unrecognized rules text: "+1: Each player discards a card. Each opponent who can\'t loses 3 life."',
    'unrecognized rules text: "−3: Target creature gets -X/-X until end of turn, where X is the number of cards in your graveyard."',
    'unrecognized rules text: "−7: You get an emblem with "At the beginning of combat on your turn, put target creature card from a graveyard onto the battlefield under your control. It gains haste.""',
  ], { activatedAbilities: [
    loyaltyAbility(1, { effects: [{ op: 'discardEachPlayer', scope: 'all', count: constant(1), opponentsUnableLoseLife: constant(3) }], description: 'Each player discards; opponents unable to discard lose 3 life' }),
    loyaltyAbility(-3, { targets: creature.targets, effects: [{ op: 'pumpUntilEot', target: creature.slot.creature, power: minusGraveyardSize, toughness: minusGraveyardSize }], description: 'Target creature gets -X/-X for your graveyard size' }),
    loyaltyAbility(-7, { effects: [{ op: 'createEmblem', name: 'Liliana, Waker of the Dead emblem', abilities: [triggered(onBeginCombat('you'), {
      targets: graveyard.targets, effects: [{ op: 'graveyardToBattlefield', target: graveyard.slot.creature, gainsHaste: true }], description: 'Return target creature card from any graveyard under your control with haste',
    })] }], description: 'Create a beginning-of-combat reanimation emblem' }),
  ] }, 'Evaluates graveyard size at resolution and creates a persistent emblem with unrestricted graveyard ownership and permanent haste.');
}
