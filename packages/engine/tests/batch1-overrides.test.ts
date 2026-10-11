import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { oracle } from './fixtures';

describe('Batch 1 card overrides', () => {
  it('models Emmara, Soul of the Accord with tapped trigger', () => {
    const card = oracle({
      oracleId: 'c65ba242-3369-48a9-864f-1b1f85238f67',
      name: 'Emmara, Soul of the Accord',
      typeLine: 'Legendary Creature — Elf Cleric',
      manaCost: '{G}{W}',
      oracleText:
        'Whenever Emmara, Soul of the Accord becomes tapped, create a 1/1 white Soldier creature token with lifelink.',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers?.[0]?.trigger).toEqual({
      when: 'becomesTapped',
      subject: { kind: 'self' },
    });
  });

  it("models Karametra's Favor's enters draw and granted mana ability with no override (coverage PR05)", () => {
    const card = oracle({
      oracleId: 'fc3e48c9-e303-435c-bdb1-7dc7881a9858',
      name: "Karametra's Favor",
      typeLine: 'Enchantment — Aura',
      manaCost: '{1}{G}',
      oracleText:
        'Enchant creature\nWhen this Aura enters, draw a card.\nEnchanted creature has "{T}: Add one mana of any color."',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.unmodeledReasons).toEqual([]);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]?.effects).toEqual([{ op: 'draw', count: { kind: 'const', n: 1 } }]);
    expect(def.staticEffects).toEqual([
      {
        affects: { kind: 'attachedToSource' },
        op: { layer: 6, addManaAbility: { units: [['W', 'U', 'B', 'R', 'G']] } },
      },
    ]);
  });

  it('models Leafkin Druid with conditional mana ability', () => {
    const card = oracle({
      oracleId: '55eb9310-f24b-410b-850b-a7d0d5117946',
      name: 'Leafkin Druid',
      typeLine: 'Creature — Elemental Druid',
      manaCost: '{1}{G}',
      oracleText: '{T}: Add {G}. If you control four or more creatures, add {G}{G} instead.',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.manaAbilities).toHaveLength(1);
    expect(def.manaAbilities?.[0]?.conditionalUnits).toBeDefined();
  });

  it('models the tap-four cost including this creature (coverage PR02)', () => {
    const card = oracle({
      oracleId: '4dcfd397-9d29-420c-8fd8-c7c2a99de122',
      name: 'Nullmage Shepherd',
      typeLine: 'Creature — Elf Shaman',
      manaCost: '{3}{G}',
      oracleText:
        'Tap four untapped creatures you control: Destroy target artifact or enchantment.',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.activatedAbilities[0]?.costs).toEqual([
      expect.objectContaining({ kind: 'tapOthers', count: 4, allowSelf: true }),
    ]);
  });

  it('models the lieutenant buff for creatures only (coverage PR01)', () => {
    const card = oracle({
      oracleId: 'f55334d9-1ec2-4667-bf28-5a0384d6f053',
      name: 'Thunderfoot Baloth',
      typeLine: 'Creature — Beast',
      manaCost: '{4}{G}{G}',
      oracleText:
        'Trample\nLieutenant — As long as you control your commander, this creature gets +2/+2 and other creatures you control get +2/+2 and have trample.',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    const others = def.staticEffects.filter((effect) => effect.affects.kind === 'allOf');
    expect(others).toHaveLength(2);
    for (const effect of others) {
      expect(JSON.stringify(effect.affects)).toContain('"value":"Creature"');
    }
  });

  it('models Fortified Village with reveal condition', () => {
    const card = oracle({
      oracleId: '56f1a16a-9f41-41fb-b580-c200bca27cd6',
      name: 'Fortified Village',
      typeLine: 'Land',
      manaCost: '',
      oracleText:
        "As Fortified Village enters, you may reveal a Forest or Plains card from your hand. If you don't, Fortified Village enters tapped.",
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.entersTappedUnless).toEqual({
      kind: 'mayRevealCardFromHand',
      subtypes: ['Forest', 'Plains'],
    });
  });

  it('models Overwhelming Instinct with attack trigger condition', () => {
    const card = oracle({
      oracleId: '9ba89c25-5302-414f-a2ec-436b8981999d',
      name: 'Overwhelming Instinct',
      typeLine: 'Enchantment',
      manaCost: '{2}{G}',
      oracleText: 'Whenever you attack with three or more creatures, draw a card.',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.triggers).toHaveLength(1);
  });
});
