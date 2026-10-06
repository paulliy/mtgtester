import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { oracle } from './fixtures';

describe('Batch 2 card overrides', () => {
  it('models Rishkar with an up-to-two counter slot and the granted mana ability (coverage PR01)', () => {
    const card = oracle({
      oracleId: '761021ce-4559-464e-aa03-85c2fe78e267',
      name: 'Rishkar, Peema Renegade',
      typeLine: 'Legendary Creature — Elf Druid',
      manaCost: '{2}{G}',
      oracleText:
        'When Rishkar enters, put a +1/+1 counter on each of up to two target creatures.\nEach creature you control with a counter on it has "{T}: Add {G}."',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.triggers[0]?.targets[0]?.count).toEqual({ min: 0, max: 2 });
    expect(def.staticEffects).toHaveLength(1);
  });

  it('models Ajani, Caller of the Pride', () => {
    const card = oracle({
      oracleId: '1d5ff280-7f4d-4801-aefd-9b6e6b1f2818',
      name: 'Ajani, Caller of the Pride',
      typeLine: 'Legendary Planeswalker — Ajani',
      manaCost: '{1}{W}{W}',
      loyalty: '4',
      oracleText:
        '+1: Put a +1/+1 counter on up to one target creature.\n−3: Target creature gains flying and double strike until end of turn.\n−8: Create X 2/2 white Cat creature tokens, where X is your life total.',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.activatedAbilities).toHaveLength(3);
  });

  it('models Sylvan Reclamation with an up-to-two exile slot (coverage PR01)', () => {
    const card = oracle({
      oracleId: 'aeec8e85-6571-4da6-8a48-f5d3985ca10b',
      name: 'Sylvan Reclamation',
      typeLine: 'Instant',
      manaCost: '{3}{G}{W}',
      oracleText: 'Exile up to two target artifacts and/or enchantments.\nBasic landcycling {2}',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.spellAbility?.targets[0]?.count).toEqual({ min: 0, max: 2 });
    expect(def.spellAbility?.effects).toEqual([{ op: 'exileEachChosen', targetSlot: 0 }]);
  });

  it('models Mentor of the Meek', () => {
    const card = oracle({
      oracleId: 'b9f4f96b-6e54-4fe6-8df7-623e0fc72409',
      name: 'Mentor of the Meek',
      typeLine: 'Creature — Human Soldier',
      manaCost: '{2}{W}',
      oracleText:
        'Whenever another creature you control with power 2 or less enters, you may pay {1}. If you do, draw a card.',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.triggers).toHaveLength(1);
  });

  it("models Commander's Insignia", () => {
    const card = oracle({
      oracleId: '979a5d92-1c67-4fa4-b932-638b0cc1adcd',
      name: "Commander's Insignia",
      typeLine: 'Enchantment',
      manaCost: '{2}{W}',
      oracleText:
        "Creatures you control get +1/+1 for each time you've cast your commander from the command zone this game.",
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.staticEffects).toHaveLength(1);
  });

  it('models Voice of Many counting only opponents still in the game (coverage PR01)', () => {
    const card = oracle({
      oracleId: '9b40faad-1b96-4461-89d8-9a207b58e832',
      name: 'Voice of Many',
      typeLine: 'Creature — Elf Druid',
      manaCost: '{2}{G}{G}',
      oracleText:
        'When this creature enters, draw a card for each opponent who controls fewer creatures than you.',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.triggers[0]?.effects).toEqual([
      { op: 'draw', count: { kind: 'countOpponentsWithFewerCreatures' } },
    ]);
  });

  it('models Loyal Guardian', () => {
    const card = oracle({
      oracleId: 'de1cfa83-2049-48ab-b093-2f120a3ef4f2',
      name: 'Loyal Guardian',
      typeLine: 'Creature — Bear',
      manaCost: '{4}{G}',
      oracleText:
        'At the beginning of combat on your turn, if you control your commander, put a +1/+1 counter on each creature you control.',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.triggers).toHaveLength(1);
  });

  it('models Dawn of Hope', () => {
    const card = oracle({
      oracleId: 'd7a38484-2acc-49a6-b32d-d54dddb14d31',
      name: 'Dawn of Hope',
      typeLine: 'Enchantment',
      manaCost: '{1}{W}',
      oracleText: 'Whenever you gain life, you may pay {2}. If you do, draw a card.',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.triggers).toHaveLength(1);
  });

  it('models Hornet Nest', () => {
    const card = oracle({
      oracleId: '123d2b6e-114e-4767-860d-50790382ca4a',
      name: 'Hornet Nest',
      typeLine: 'Creature — Insect',
      manaCost: '{2}{G}',
      oracleText:
        'Whenever Hornet Nest is dealt damage, create that many 1/1 green Insect creature tokens with flying and deathtouch.',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.triggers).toHaveLength(1);
  });

  it('contains Idol of Oblivion', () => {
    const card = oracle({
      oracleId: 'c232d974-9c65-4bce-b045-e5a7cc0c62e0',
      name: 'Idol of Oblivion',
      typeLine: 'Artifact',
      manaCost: '{2}',
      oracleText: '{T}: Draw a card. Activate only if you created a token this turn.',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(false);
    expect(def.unmodeledReasons.join('\n')).toContain(
      'The draw restriction is a resolution no-op, and the token is an Eldrazi Construct artifact instead of an Eldrazi creature.',
    );
  });

  it('models Trostani Discordant', () => {
    const card = oracle({
      oracleId: '9a2fdc0e-e0de-47fc-95e4-04e725ddf060',
      name: 'Trostani Discordant',
      typeLine: 'Legendary Creature — Dryad',
      manaCost: '{3}{G}{W}',
      oracleText:
        'When Trostani enters, create two 1/1 white Soldier creature tokens with lifelink.\nAt the beginning of your end step, each player gains control of all creatures they own.',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.triggers).toHaveLength(2);
  });

  it('models Harvest Season with X counting tapped creatures (coverage PR01)', () => {
    const card = oracle({
      oracleId: 'ec6d52f9-1c8f-48da-951c-be8d7813c7be',
      name: 'Harvest Season',
      typeLine: 'Sorcery',
      manaCost: '{2}{G}',
      oracleText:
        'Search your library for up to X basic land cards, where X is the number of tapped creatures you control, put those cards onto the battlefield tapped, then shuffle.',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.spellAbility?.effects[0]).toMatchObject({
      op: 'searchLibrary',
      count: { kind: 'countTappedPermanents', scope: 'you' },
    });
  });

  it('models Slate of Ancestry', () => {
    const card = oracle({
      oracleId: 'a07483b4-c04f-42a4-b979-8b77c11fa8f5',
      name: 'Slate of Ancestry',
      typeLine: 'Artifact',
      manaCost: '{4}',
      oracleText: '{4}, {T}, Discard your hand: Draw a card for each creature you control.',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.activatedAbilities).toHaveLength(1);
  });

  it('contains Scavenging Ooze', () => {
    const card = oracle({
      oracleId: '1ff25f67-36a7-4cfa-a2b1-2135b5b6fb67',
      name: 'Scavenging Ooze',
      typeLine: 'Creature — Ooze',
      manaCost: '{1}{G}',
      oracleText:
        '{G}: Exile target card from a graveyard. If it was a creature card, put a +1/+1 counter on Scavenging Ooze and you gain 1 life.',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(false);
    expect(def.unmodeledReasons.join('\n')).toContain(
      'Exile splices the card without a zone-change, so leave-graveyard events are skipped.',
    );
  });

  it('models Felidar Retreat', () => {
    const card = oracle({
      oracleId: '16629f59-bae8-4c19-bf50-443eb0ed6856',
      name: 'Felidar Retreat',
      typeLine: 'Enchantment',
      manaCost: '{3}{W}',
      oracleText:
        'Whenever a land you control enters, choose one —\n• Create a 2/2 white Cat Beast creature token.\n• Put a +1/+1 counter on each creature you control. Those creatures gain vigilance until end of turn.',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.triggers).toHaveLength(1);
  });

  it('models Great Oak Guardian', () => {
    const card = oracle({
      oracleId: '5dba7746-c087-4ec1-92ca-ab9882dea24d',
      name: 'Great Oak Guardian',
      typeLine: 'Creature — Treefolk',
      manaCost: '{5}{G}',
      oracleText:
        'When Great Oak Guardian enters, creatures target player controls get +2/+2 until end of turn. Untap them.',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.triggers).toHaveLength(1);
  });
});
