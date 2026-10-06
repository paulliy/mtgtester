import { describe, expect, test } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import { oracle } from './fixtures';

function makeCard(
  name: string,
  typeLine: string,
  oracleText: string,
  extra: Partial<OracleCard> = {},
): OracleCard {
  return oracle({ name, typeLine, oracleText, ...extra });
}

describe('Generic Static Parser Expansions (Milestone 2 Task 1)', () => {
  test('Category 1: Keyword Costs (Convoke, Cycling, Crew, Improvise, Kicker, Unearth)', () => {
    // Convoke
    const convokeCard = interpretCard(
      makeCard('Test Convoke', 'Sorcery', 'Convoke\nDeal 3 damage to any target.'),
    );
    expect(convokeCard.keywords).toContain('convoke');
    expect(convokeCard.ruleStatics.some((r) => r.kind === 'convoke')).toBe(true);

    // Improvise
    const improviseCard = interpretCard(
      makeCard('Test Improvise', 'Artifact Creature — Construct', 'Improvise'),
    );
    expect(improviseCard.keywords).toContain('improvise');
    expect(improviseCard.ruleStatics.some((r) => r.kind === 'improvise')).toBe(true);

    // Crew
    const crewCard = interpretCard(makeCard('Test Vehicle', 'Artifact — Vehicle', 'Crew 3'));
    expect(crewCard.activatedAbilities).toHaveLength(1);
    expect(crewCard.activatedAbilities[0]!.costs).toEqual([
      { kind: 'tapCreaturesTotalPower', minPower: 3 },
    ]);

    // Cycling
    const cyclingCard = interpretCard(
      makeCard('Test Cycling', 'Instant', 'Cycling {2}\nDraw a card.'),
    );
    expect(cyclingCard.activatedAbilities.some((a) => a.zone === 'hand')).toBe(true);

    // Typecycling
    const typecyclingCard = interpretCard(
      makeCard('Test Plains Cycling', 'Instant', 'Plainscycling {2}'),
    );
    expect(typecyclingCard.activatedAbilities.some((a) => a.zone === 'hand')).toBe(true);

    const basicLandcycling = interpretCard(
      makeCard('Test Basic Land Cycling', 'Instant', 'Basic landcycling {2}'),
    );
    expect(basicLandcycling.activatedAbilities[0]?.ability.effects).toEqual([
      {
        op: 'searchLibrary',
        filter: {
          kind: 'allOf',
          of: [
            { kind: 'type', value: 'Land' },
            { kind: 'supertype', value: 'Basic' },
          ],
        },
        destinations: [{ zone: 'hand' }],
        reveal: true,
        allowFailToFind: true,
      },
      { op: 'shuffle' },
    ]);

    // Kicker fails CLOSED. It used to push `{ kind: 'kicker' }`, but nothing consumed it and
    // `wasKicked` was never assigned, so "if it was kicked" always took the not-kicked branch
    // while the card reported modeled. Until the additional-cost path exists, the line must
    // land in `unrecognized` so the card is honestly unmodeled rather than quietly wrong.
    const kickerCard = interpretCard(
      makeCard(
        'Test Kicker',
        'Creature — Dragon',
        'Kicker {2}\nWhen ~ enters, if it was kicked, put two +1/+1 counters on it.',
      ),
    );
    expect(kickerCard.ruleStatics.some((r) => r.kind === 'kicker')).toBe(false);
    expect(kickerCard.modeled).toBe(false);

    // Unearth
    const unearthCard = interpretCard(
      makeCard('Test Unearth', 'Creature — Zombie', 'Unearth {2}{B}'),
    );
    expect(unearthCard.activatedAbilities.some((a) => a.zone === 'graveyard')).toBe(true);
  });

  test('Category 2: Aura Statics & Equipment Grants', () => {
    // Enchant creature & Enchanted creature gets +2/+2
    const auraCard = interpretCard(
      makeCard(
        'Test Aura',
        'Enchantment — Aura',
        'Enchant creature\nEnchanted creature gets +2/+2.',
      ),
    );
    expect(auraCard.modeled).toBe(true);
    expect(auraCard.staticEffects.some((s) => s.affects.kind === 'attachedToSource')).toBe(true);

    // Equipped creature has keywords
    const equipCard = interpretCard(
      makeCard(
        'Test Sword',
        'Artifact — Equipment',
        'Equip {2}\nEquipped creature has reach and vigilance.',
      ),
    );
    expect(equipCard.modeled).toBe(true);
    expect(equipCard.staticEffects.some((s) => s.op.layer === 6)).toBe(true);

    const combatTrigger = interpretCard(
      makeCard(
        'Test Mask',
        'Artifact — Equipment',
        'Whenever equipped creature attacks, draw a card.',
      ),
    );
    expect(combatTrigger.modeled).toBe(true);
    expect(combatTrigger.triggers[0]?.trigger).toEqual({
      when: 'attacks',
      subject: { kind: 'permanent', selector: { kind: 'attachedToSource' } },
    });
  });

  test('Category 3: Counter Operations', () => {
    const counterCard = interpretCard(
      makeCard(
        'Test Counters',
        'Sorcery',
        'Put two +1/+1 counters on target creature. Remove a +1/+1 counter from target creature.',
      ),
    );
    expect(counterCard.spellAbility?.effects.some((e) => e.op === 'putCounters')).toBe(true);
    expect(counterCard.spellAbility?.effects.some((e) => e.op === 'removeCounters')).toBe(true);
  });

  test('Category 4: Generic Token Creation', () => {
    // Tapped Necron Warrior artifact creature token
    const necronCard = interpretCard(
      makeCard(
        'Test Token 1',
        'Sorcery',
        'Create X tapped 2/2 black Necron Warrior artifact creature tokens.',
      ),
    );
    expect(necronCard.spellAbility?.effects[0]!.op).toBe('createToken');

    // Named legendary token
    const legendaryTokenCard = interpretCard(
      makeCard(
        'Test Token 2',
        'Sorcery',
        'Create Karox Bladewing, a legendary 4/4 red Dragon creature token with flying.',
      ),
    );
    expect(legendaryTokenCard.spellAbility?.effects[0]!.op).toBe('createToken');

    // Thopter token with flying
    const thopterCard = interpretCard(
      makeCard(
        'Test Token 3',
        'Sorcery',
        'Create two 1/1 colorless Thopter artifact creature tokens with flying.',
      ),
    );
    expect(thopterCard.spellAbility?.effects[0]!.op).toBe('createToken');
  });

  test('Category 5: Mass Removal Filters', () => {
    const windsCard = interpretCard(
      makeCard(
        'Winds of Rath',
        'Sorcery',
        "Destroy all creatures that aren't enchanted. They can't be regenerated.",
      ),
    );
    expect(windsCard.modeled).toBe(true);
    expect(windsCard.spellAbility?.effects[0]!.op).toBe('destroyEach');

    const exileCard = interpretCard(
      makeCard('Exile All Nonland', 'Sorcery', 'Exile all nonland permanents.'),
    );
    expect(exileCard.modeled).toBe(true);
    expect(exileCard.spellAbility?.effects[0]!.op).toBe('exileEach');
  });

  test('Category 6: Graveyard Recursion Clauses', () => {
    const wakeCard = interpretCard(
      makeCard(
        'Wake the Past',
        'Sorcery',
        'Return all artifact cards from your graveyard to the battlefield. They gain haste until end of turn.',
      ),
    );
    expect(wakeCard.modeled).toBe(true);
    expect(wakeCard.spellAbility?.effects.some((e) => e.op === 'graveyardToBattlefieldEach')).toBe(
      true,
    );

    const targetedCard = interpretCard(
      makeCard(
        'Reanimate Creature',
        'Sorcery',
        'Return target creature card from your graveyard to the battlefield.',
      ),
    );
    expect(targetedCard.modeled).toBe(true);
    expect(targetedCard.spellAbility?.effects[0]!.op).toBe('graveyardToBattlefield');

    const legendaryMass = interpretCard(
      makeCard(
        'Legendary Return',
        'Sorcery',
        'Return all legendary creature cards from your graveyard to your hand.',
      ),
    );
    expect(legendaryMass.modeled).toBe(true);
    expect(legendaryMass.spellAbility?.effects).toEqual([
      {
        op: 'graveyardToHandEach',
        filter: {
          kind: 'allOf',
          of: [
            { kind: 'supertype', value: 'Legendary' },
            { kind: 'type', value: 'Creature' },
          ],
        },
      },
    ]);
  });
});
