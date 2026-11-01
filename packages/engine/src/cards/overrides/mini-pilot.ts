import type { CardDefinition } from '../definition';
import { allOf, ofType, OPPONENTS, withKeyword } from '../selector';
import { manaCost, spell, targetSlots } from '../templates';
import { constant } from '../value';
import { defineCard, defineSpellFace } from './index';

/**
 * Card batch `mini-pilot` (card authoring plan, phase 2 step 9), started with card:new: three
 * cards modeled with the authoring commands to time them against the PR11 baseline.
 */

/**
 * "~ deals N damage to target creature you don't control. Overload …": the spell deals the
 * damage (CR 120.3). In Commander every other player is an opponent, so "you don't control" is an
 * opponent's creature. Overload (CR 702.96) changes "target" to "each": the overloaded spell has
 * no target, so hexproof does not stop it, and it deals N to each creature you don't control.
 */
function damageWithOverload(
  amount: number,
  overloadCost: string,
  overloadText: string,
): Partial<CardDefinition> {
  const hit = targetSlots({ creature: { kind: 'creature', controller: 'opponent' } });
  return {
    spellAbility: spell({
      targets: hit.targets,
      effects: [{ op: 'dealDamage', target: hit.slot.creature, amount: constant(amount) }],
      description: `Deal ${amount} damage to target creature you don't control`,
    }),
    alternativeCasts: [
      {
        kind: 'overload',
        manaCost: manaCost(overloadCost),
        description: overloadText,
        ability: spell({
          targets: [],
          effects: [
            {
              op: 'damageEach',
              selector: allOf(ofType('Creature'), OPPONENTS),
              amount: constant(amount),
            },
          ],
          description: `Deal ${amount} damage to each creature you don't control`,
        }),
      },
    ],
  };
}

export function registerMiniPilotOverrides(): void {
  defineCard(
    '48ddba1e-2ad7-463f-9307-d2379a800e51',
    'Mizzium Mortars',
    ["~ deals 4 damage to target creature you don't control."],
    damageWithOverload(4, '{3}{R}{R}{R}', 'Overload {3}{R}{R}{R}'),
  );

  defineCard(
    '99fd4b51-1698-4168-9366-a6ea2df22361',
    'Electrickery',
    ["~ deals 1 damage to target creature you don't control."],
    damageWithOverload(1, '{1}{R}', 'Overload {1}{R}'),
  );

  // Web Shot, Ettercap's Adventure (CR 715): an instant that destroys a creature with flying. The
  // target must have flying when chosen and again on resolution (CR 608.2b); the Adventure's own
  // exile-and-cast-later rules are the engine's.
  const flier = targetSlots({ creature: { kind: 'creature', filter: withKeyword('flying') } });
  defineSpellFace(
    'e0b5b3af-af89-4b91-8b55-947ec095d6f2',
    'Ettercap // Web Shot',
    'Web Shot',
    ['Destroy target creature with flying.'],
    {
      spellAbility: spell({
        targets: flier.targets,
        effects: [{ op: 'destroy', target: flier.slot.creature }],
        description: 'Destroy target creature with flying',
      }),
    },
  );
}
