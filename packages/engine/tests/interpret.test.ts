import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { bear, bolt, cancel, divination, doom, forest, giantGrowth, oracle } from './fixtures';

describe('oracle-text interpreter (brief §6)', () => {
  it('models vanilla creatures', () => {
    const def = interpretCard(bear());
    expect(def.modeled).toBe(true);
    expect(def.power).toBe(2);
    expect(def.toughness).toBe(2);
  });

  it('models keyword lines and rejects unknown keywords', () => {
    const good = interpretCard(
      oracle({ name: 'Keyworder', oracleText: 'Flying, vigilance\nDeathtouch' }),
    );
    expect(good.modeled).toBe(true);
    expect(good.keywords).toEqual(expect.arrayContaining(['flying', 'vigilance', 'deathtouch']));

    const bad = interpretCard(oracle({ name: 'Fancy', oracleText: 'Cascade' }));
    expect(bad.modeled).toBe(false);
    expect(bad.unmodeledReasons.join()).toContain('Cascade');
  });

  it('ignores reminder text', () => {
    const def = interpretCard(
      oracle({
        name: 'Reminder',
        oracleText: 'Flying (This creature can only be blocked by creatures with flying or reach.)',
      }),
    );
    expect(def.modeled).toBe(true);
    expect(def.keywords).toContain('flying');
  });

  it('gives basic lands their intrinsic mana ability', () => {
    const def = interpretCard(forest());
    expect(def.modeled).toBe(true);
    expect(def.manaAbilities).toEqual([{ units: [['G']] }]);
  });

  it('parses explicit mana abilities (Sol Ring pattern)', () => {
    const def = interpretCard(
      oracle({
        name: 'Test Ring',
        typeLine: 'Artifact',
        manaCost: '{1}',
        power: null,
        toughness: null,
        oracleText: '{T}: Add {C}{C}.',
      }),
    );
    expect(def.modeled).toBe(true);
    expect(def.manaAbilities).toEqual([{ units: [['C'], ['C']] }]);
  });

  it('parses enters-tapped lands', () => {
    const def = interpretCard(
      oracle({
        name: 'Slowland',
        typeLine: 'Land',
        manaCost: null,
        power: null,
        toughness: null,
        oracleText: 'Slowland enters the battlefield tapped.\n{T}: Add {W}.',
      }),
    );
    expect(def.modeled).toBe(true);
    expect(def.entersTapped).toBe(true);
    expect(def.manaAbilities).toEqual([{ units: [['W']] }]);
  });

  it('parses the Phase 2 spell-effect patterns', () => {
    expect(interpretCard(giantGrowth()).spellEffects).toEqual([
      { kind: 'pump', power: 3, toughness: 3 },
    ]);
    expect(interpretCard(bolt()).spellEffects).toEqual([
      { kind: 'damageTarget', amount: 3, targetKind: 'anyTarget' },
    ]);
    expect(interpretCard(doom()).spellEffects).toEqual([{ kind: 'destroyTarget' }]);
    expect(interpretCard(cancel()).spellEffects).toEqual([{ kind: 'counterTarget' }]);
    expect(interpretCard(divination()).spellEffects).toEqual([{ kind: 'draw', count: 2 }]);
  });

  it('parses triggers: ETB, dies, upkeep — including optional ("you may")', () => {
    const def = interpretCard(
      oracle({
        name: 'Test Sage',
        oracleText:
          'When Test Sage enters the battlefield, draw a card.\nWhen Test Sage dies, you may draw a card.\nAt the beginning of your upkeep, you gain 1 life.',
      }),
    );
    expect(def.modeled).toBe(true);
    expect(def.triggers).toHaveLength(3);
    expect(def.triggers[0]).toMatchObject({ event: 'etbSelf', optional: false });
    expect(def.triggers[1]).toMatchObject({ event: 'diesSelf', optional: true });
    expect(def.triggers[2]).toMatchObject({ event: 'upkeepYours' });
  });

  it('marks unrecognized rules text, weird layouts, and * P/T as unmodeled', () => {
    const weird = interpretCard(
      oracle({ name: 'Weirdo', oracleText: 'Whenever you cast a spell, proliferate.' }),
    );
    expect(weird.modeled).toBe(false);

    const star = interpretCard(oracle({ name: 'Starry', power: '*', toughness: '1' }));
    expect(star.modeled).toBe(false);

    const dfc = interpretCard(oracle({ name: 'Flip', layout: 'transform' }));
    expect(dfc.modeled).toBe(false);
  });

  it('marks unsupported cost symbols as unmodeled', () => {
    const def = interpretCard(oracle({ name: 'Hybrid', manaCost: '{W/U}{W/U}' }));
    expect(def.modeled).toBe(false);
    expect(def.hasUnsupportedCost).toBe(true);
  });

  it('marks a spell with uninterpretable effects as unmodeled', () => {
    const def = interpretCard(
      oracle({
        name: 'Odd Spell',
        typeLine: 'Sorcery',
        power: null,
        toughness: null,
        oracleText: 'Rearrange the top three cards of target library.',
      }),
    );
    expect(def.modeled).toBe(false);
  });
});
