/**
 * `createTokenAttacking` with `player: 'eventPlayer'` and `defender: 'attackedPlayer'` (Combat
 * Calligrapher): the attacked-player reference only exists in a per-defender attack declaration
 * trigger, and the event player only in a trigger that has one. The behavior is exercised through
 * the card in pr07-card-coverage.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import type { CardDefinition } from '../src/cards/definition';
import type { TriggerHead } from '../src/cards/ability';
import { triggered } from '../src/cards/templates';
import { constant } from '../src/cards/value';
import { INKLING_2_1_FLYING } from '../src/cards/tokens';

function definition(head: TriggerHead): CardDefinition {
  return {
    oracleId: 'token-attacking-probe',
    name: 'Token attacking probe',
    typeLine: 'Enchantment',
    supertypes: [],
    types: ['Enchantment'],
    subtypes: [],
    colors: [],
    colorIdentity: [],
    manaCost: null,
    hasUnsupportedCost: false,
    power: null,
    toughness: null,
    loyalty: null,
    defense: null,
    keywords: [],
    manaAbilities: [],
    activatedAbilities: [],
    entersTapped: false,
    spellAbility: null,
    triggers: [
      triggered(head, {
        effects: [
          {
            op: 'createTokenAttacking',
            spec: INKLING_2_1_FLYING,
            count: constant(1),
            player: 'eventPlayer',
            defender: 'attackedPlayer',
          },
        ],
        description: 'probe',
      }),
    ],
    staticEffects: [],
    ruleStatics: [],
    modeled: true,
    unmodeledReasons: [],
  };
}

describe('createTokenAttacking event references', () => {
  it('accepts the attacked player and the event player in a per-defender attack declaration trigger', () => {
    expect(
      validateCardDefinition(
        definition({
          when: 'attackDeclared',
          attacker: 'any',
          attacking: { who: 'opponent', planeswalkers: false },
          perDefender: true,
        }),
      ),
    ).toEqual([]);
  });

  it('rejects the attacked player without a per-defender attack declaration, and the event player without an event', () => {
    const paths = (head: TriggerHead) =>
      validateCardDefinition(definition(head)).map((issue) => `${issue.path}: ${issue.message}`);
    expect(
      paths({
        when: 'attackDeclared',
        attacker: 'any',
        attacking: { who: 'opponent', planeswalkers: false },
      }).join('\n'),
    ).toMatch(/attacked player reference needs a per-defender attack declaration trigger/);
    expect(paths({ when: 'endStep', player: 'you' }).join('\n')).toMatch(
      /attacked player reference needs a per-defender attack declaration trigger/,
    );
  });
});
