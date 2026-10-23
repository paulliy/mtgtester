/**
 * "Return this card" and "return that card ... under its owner's control" read a card that left
 * the battlefield, so they parse only under a head that puts it in a graveyard: the source
 * leaving, or the creature this Aura or Equipment is attached to dying (CR 400.7e, 704.5m).
 * Under any other head the line stays unrecognized instead of parsing into a no-op.
 */
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { oracle } from './fixtures';

const creature = (oracleText: string) =>
  interpretCard(
    oracle({
      name: 'Lab Return',
      typeLine: 'Creature — Spirit',
      power: '1',
      toughness: '1',
      oracleText,
    }),
  );
const aura = (oracleText: string) =>
  interpretCard(
    oracle({
      name: 'Lab Aura',
      typeLine: 'Enchantment — Aura',
      oracleText: `Enchant creature\n${oracleText}`,
    }),
  );

describe('departed-card returns are gated on the trigger head', () => {
  it('"return this card" needs the source leaving or its creature dying', () => {
    expect(
      creature(
        'At the beginning of your upkeep, return this card from your graveyard to the battlefield.',
      ).modeled,
    ).toBe(false);
    expect(
      creature(
        'Whenever a land you control enters, return this card from your graveyard to the battlefield.',
      ).modeled,
    ).toBe(false);
    expect(
      creature(
        'When this creature dies, return this card to the battlefield at the beginning of the next end step.',
      ).modeled,
    ).toBe(true);
    expect(
      aura('When enchanted creature dies, return this card from your graveyard to the battlefield.')
        .modeled,
    ).toBe(true);
  });

  it('"return this card to the battlefield" under a leave head needs it to go to a graveyard', () => {
    // The card could have gone to exile, a hand or a library, where the return can't find it.
    expect(
      creature('When this creature leaves the battlefield, return this card to the battlefield.')
        .modeled,
    ).toBe(false);
    expect(
      creature(
        'When this creature leaves the battlefield, return this card from your graveyard to the battlefield.',
      ).modeled,
    ).toBe(true);
    expect(
      creature(
        'When this creature is put into a graveyard from the battlefield, return this card to the battlefield.',
      ).modeled,
    ).toBe(true);
  });

  it('"attached to that creature" needs the enchanted creature dying', () => {
    expect(
      creature(
        'When this creature dies, return this card to the battlefield attached to that creature.',
      ).modeled,
    ).toBe(false);
  });

  it('"return that card ... under its owner\'s control" needs a dies head, not a leave head', () => {
    expect(
      creature(
        "Whenever a creature you control leaves the battlefield, return that card to the battlefield under its owner's control.",
      ).modeled,
    ).toBe(false);
    expect(
      creature(
        "Whenever a creature you control leaves the battlefield, return that card to the battlefield under its owner's control at the beginning of the next end step.",
      ).modeled,
    ).toBe(false);
    expect(
      aura(
        "When enchanted creature dies, return that card to the battlefield under its owner's control.",
      ).modeled,
    ).toBe(true);
  });
});
