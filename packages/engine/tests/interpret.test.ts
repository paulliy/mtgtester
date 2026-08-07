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

  it('models no-maximum-hand-size as a rule static', () => {
    const def = interpretCard(oracle({
      name: 'Test Tower', typeLine: 'Land', manaCost: null, power: null, toughness: null,
      oracleText: 'You have no maximum hand size.\n{T}: Add {C}.',
    }));
    expect(def.modeled).toBe(true);
    expect(def.ruleStatics).toContainEqual({ kind: 'noMaximumHandSize' });
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

  it('parses a choice-of-color mana ability as ONE unit with several symbols', () => {
    // "{G} or {W}" is one mana whose color the player picks — NOT two mana. Getting this
    // wrong would let a dual land pay a two-pip cost by itself.
    const def = interpretCard(
      oracle({
        name: 'Test Dual',
        typeLine: 'Land',
        manaCost: null,
        power: null,
        toughness: null,
        oracleText: '{T}: Add {G} or {W}.',
      }),
    );
    expect(def.modeled).toBe(true);
    expect(def.manaAbilities).toEqual([{ units: [['G', 'W']] }]);
  });

  it('parses a three-way choice-of-color mana ability', () => {
    const def = interpretCard(
      oracle({
        name: 'Test Triome',
        typeLine: 'Land',
        manaCost: null,
        power: null,
        toughness: null,
        oracleText: '{T}: Add {W}, {U}, or {B}.',
      }),
    );
    expect(def.modeled).toBe(true);
    expect(def.manaAbilities).toEqual([{ units: [['W', 'U', 'B']] }]);
  });

  it('parses "Add one mana of any color" as a five-symbol choice', () => {
    const def = interpretCard(
      oracle({
        name: 'Test Tower',
        typeLine: 'Land',
        manaCost: null,
        power: null,
        toughness: null,
        oracleText: '{T}: Add one mana of any color.',
      }),
    );
    expect(def.modeled).toBe(true);
    expect(def.manaAbilities).toEqual([{ units: [['W', 'U', 'B', 'R', 'G']] }]);
  });

  const manaLand = (oracleText: string): ReturnType<typeof interpretCard> =>
    interpretCard(
      oracle({
        name: 'Test Restricted',
        typeLine: 'Land',
        manaCost: null,
        power: null,
        toughness: null,
        oracleText,
      }),
    );

  it('reads a CR 106.6 spending restriction onto the mana produced', () => {
    // Restricted mana became expressible in Inc 12a: the restriction rides on the `ManaEntry`,
    // and `planPayment` drops it for any payment it does not permit.
    const def = manaLand('{T}: Add {C}. Spend this mana only to cast artifact spells.');

    expect(def.modeled).toBe(true);
    expect(def.manaAbilities).toEqual([
      {
        units: [['C']],
        restriction: {
          purposes: ['castSpell'],
          filter: { kind: 'type', value: 'Artifact' },
          description: 'cast artifact spells',
        },
      },
    ]);
  });

  it('still refuses "two mana of any ONE color" rather than over-permitting', () => {
    // Two units each offering all five colors would let one tap pay {W}{U}, which this land
    // cannot do — the symbols are LINKED. Over-permissive modeling is worse than an honest halt
    // (brief §6.3), so it keeps its own reason until the linkage is modeled (Ilysian Caryatid).
    const def = manaLand('{T}: Add two mana of any one color.');

    expect(def.modeled).toBe(false);
    expect(def.manaAbilities).toEqual([]);
    expect(def.unmodeledReasons.join(' ')).toContain('unsupported mana production');
  });

  it('normalizes modern "This creature" self-reference templating', () => {
    // Cards printed since ~2021 say "this creature" instead of repeating the name; without
    // normalization every `~`-anchored pattern misses them.
    const def = interpretCard(
      oracle({
        name: 'Test Zapper',
        typeLine: 'Instant',
        manaCost: '{R}',
        power: null,
        toughness: null,
        oracleText: 'This creature deals 3 damage to any target.',
      }),
    );
    expect(def.modeled).toBe(true);
    expect(def.spellAbility?.effects).toEqual([{ op: 'dealDamage', target: 0, amount: { kind: 'const', n: 3 } }]);
  });

  it('drops an ability word so the ability it labels still parses (CR 207.2c)', () => {
    const def = interpretCard(
      oracle({
        name: 'Test Crafter',
        typeLine: 'Creature — Test Artificer',
        manaCost: '{1}{U}',
        power: '2',
        toughness: '2',
        oracleText: 'Metalcraft — When Test Crafter enters the battlefield, draw a card.',
      }),
    );
    expect(def.modeled).toBe(true);
    expect(def.triggers[0]?.effects).toEqual([{ op: 'draw', count: { kind: 'const', n: 1 } }]);
  });

  it('does NOT drop an em-dash prefix that carries rules meaning', () => {
    // Saga chapter markers and Vehicle flavor-name headers look similar but are not ability
    // words; stripping them would change behavior, so they stay unmodeled.
    const def = interpretCard(
      oracle({
        name: 'Test Saga',
        typeLine: 'Enchantment — Saga',
        manaCost: '{2}',
        power: null,
        toughness: null,
        oracleText: 'I — You gain 3 life.',
      }),
    );
    expect(def.modeled).toBe(false);
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

  it('parses the Phase 2 spell-effect patterns into the ability IR', () => {
    const gg = interpretCard(giantGrowth());
    expect(gg.spellAbility?.effects).toEqual([
      { op: 'pumpUntilEot', target: 0, power: 3, toughness: 3 },
    ]);
    expect(gg.spellAbility?.targets).toEqual([{ kind: 'creature' }]);

    const b = interpretCard(bolt());
    expect(b.spellAbility?.effects).toEqual([{ op: 'dealDamage', target: 0, amount: { kind: 'const', n: 3 } }]);
    expect(b.spellAbility?.targets).toEqual([{ kind: 'anyTarget' }]);

    expect(interpretCard(doom()).spellAbility?.effects).toEqual([{ op: 'destroy', target: 0 }]);
    expect(interpretCard(cancel()).spellAbility?.effects).toEqual([{ op: 'counter', target: 0 }]);
    expect(interpretCard(divination()).spellAbility?.effects).toEqual([{ op: 'draw', count: { kind: 'const', n: 2 } }]);
    expect(interpretCard(divination()).spellAbility?.targets).toEqual([]);
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
    expect(def.triggers[0]).toMatchObject({
      kind: 'triggered',
      trigger: { when: 'enters', subject: { kind: 'self' } },
      optional: false,
    });
    expect(def.triggers[1]).toMatchObject({
      kind: 'triggered',
      trigger: { when: 'dies', subject: { kind: 'self' } },
      optional: true,
    });
    expect(def.triggers[2]).toMatchObject({ trigger: { when: 'upkeep', player: 'you' } });
  });

  it('marks unrecognized rules text, weird layouts, and * P/T as unmodeled', () => {
    const weird = interpretCard(
      oracle({ name: 'Weirdo', oracleText: 'Whenever you cast a spell, investigate.' }),
    );
    expect(weird.modeled).toBe(false);

    const star = interpretCard(oracle({ name: 'Starry', power: '*', toughness: '1' }));
    expect(star.modeled).toBe(false);

    const dfc = interpretCard(oracle({ name: 'Flip', layout: 'transform' }));
    expect(dfc.modeled).toBe(false);
  });

  it('marks unsupported cost symbols as unmodeled', () => {
    const def = interpretCard(oracle({ name: 'Phyrexian', manaCost: '{G/P}' }));
    expect(def.modeled).toBe(false);
    expect(def.hasUnsupportedCost).toBe(true);
  });

  it('models planeswalkers/battles with a readable starting loyalty/defense', () => {
    const pw = interpretCard(
      oracle({
        name: 'Test Beacon',
        typeLine: 'Legendary Planeswalker — Beacon',
        manaCost: '{2}',
        power: null,
        toughness: null,
        loyalty: '4',
      }),
    );
    expect(pw.modeled).toBe(true);
    expect(pw.types).toContain('Planeswalker');
    expect(pw.loyalty).toBe(4);

    const bat = interpretCard(
      oracle({
        name: 'Test Siege',
        typeLine: 'Battle — Siege',
        manaCost: '{2}',
        power: null,
        toughness: null,
        defense: '3',
      }),
    );
    expect(bat.modeled).toBe(true);
    expect(bat.types).toContain('Battle');
    expect(bat.defense).toBe(3);
  });

  it('halts a planeswalker/battle missing its loyalty/defense, or with ability text', () => {
    const noLoyalty = interpretCard(
      oracle({
        name: 'Loyaltyless',
        typeLine: 'Planeswalker — Test',
        manaCost: '{2}',
        power: null,
        toughness: null,
      }),
    );
    expect(noLoyalty.modeled).toBe(false);
    expect(noLoyalty.unmodeledReasons.join()).toContain('starting loyalty');

    const noDefense = interpretCard(
      oracle({ name: 'Defenseless', typeLine: 'Battle — Siege', power: null, toughness: null }),
    );
    expect(noDefense.modeled).toBe(false);
    expect(noDefense.unmodeledReasons.join()).toContain('starting defense');

    // Real planeswalkers carry loyalty abilities, which are activated abilities we don't
    // model — so they still halt, on the ability text.
    const realWalker = interpretCard(
      oracle({
        name: 'Real Walker',
        typeLine: 'Legendary Planeswalker — Test',
        manaCost: '{2}{U}',
        power: null,
        toughness: null,
        loyalty: '3',
        oracleText: '[+1]: Draw a card.',
      }),
    );
    expect(realWalker.modeled).toBe(false);
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

  it('models targeted destruction and exile with target filters (Vandalblast & Vanishing Verse patterns)', () => {
    const vandalblast = interpretCard(
      oracle({
        name: 'Vandalblast Test',
        typeLine: 'Sorcery',
        manaCost: '{R}',
        power: null,
        toughness: null,
        oracleText: "Destroy target artifact you don't control.",
      }),
    );
    expect(vandalblast.modeled).toBe(true);
    expect(vandalblast.spellAbility?.effects).toEqual([
      { op: 'destroy', target: 0 },
    ]);
    expect(vandalblast.spellAbility?.targets[0]).toEqual({
      kind: 'artifact',
      controller: 'opponent',
    });

    const vanishingVerse = interpretCard(
      oracle({
        name: 'Vanishing Verse Test',
        typeLine: 'Instant',
        manaCost: '{W}{B}',
        power: null,
        toughness: null,
        oracleText: 'Exile target monocolored permanent.',
      }),
    );
    expect(vanishingVerse.modeled).toBe(true);
    expect(vanishingVerse.spellAbility?.effects).toEqual([
      { op: 'exile', target: 0 },
    ]);
    expect(vanishingVerse.spellAbility?.targets[0]).toEqual({
      kind: 'permanent',
      filter: { kind: 'isMonocolored' },
    });

    const fracture = interpretCard(
      oracle({
        name: 'Fracture Test',
        typeLine: 'Instant',
        manaCost: '{W}{B}',
        power: null,
        toughness: null,
        oracleText: 'Destroy target artifact, enchantment, or planeswalker.',
      }),
    );
    expect(fracture.modeled).toBe(true);
    expect(fracture.spellAbility?.effects).toEqual([{ op: 'destroy', target: 0 }]);
    expect(fracture.spellAbility?.targets).toEqual([
      { kind: 'artifactEnchantmentOrPlaneswalker' },
    ]);
  });

  it('models a mana-costed "add mana" line as a stack ability (signets, rituals)', () => {
    const signet = interpretCard(
      oracle({
        name: 'Test Signet',
        typeLine: 'Artifact',
        manaCost: '{2}',
        power: null,
        toughness: null,
        oracleText: '{1}, {T}: Add {U}{B}.',
      }),
    );
    expect(signet.modeled).toBe(true);
    expect(signet.manaAbilities).toHaveLength(0);
    expect(signet.activatedAbilities?.[0]?.costs).toEqual([
      { kind: 'mana', cost: expect.objectContaining({ generic: 1 }) },
      { kind: 'tap' },
    ]);
    expect(signet.activatedAbilities?.[0]?.ability.effects).toEqual([
      { op: 'addMana', amount: { kind: 'const', n: 2 }, colors: [], fixedSymbols: ['U', 'B'] },
    ]);

    const ritual = interpretCard(
      oracle({
        name: 'Test Ritual',
        typeLine: 'Instant',
        manaCost: '{B}',
        power: null,
        toughness: null,
        oracleText: 'Add {B}{B}{B}.',
      }),
    );
    expect(ritual.modeled).toBe(true);
    expect(ritual.spellAbility?.effects).toEqual([
      { op: 'addMana', amount: { kind: 'const', n: 3 }, colors: [], fixedSymbols: ['B', 'B', 'B'] },
    ]);
  });

  it('counters a noncreature spell', () => {
    const negate = interpretCard(
      oracle({
        name: 'Negate Test',
        typeLine: 'Instant',
        manaCost: '{1}{U}',
        power: null,
        toughness: null,
        oracleText: 'Counter target noncreature spell.',
      }),
    );
    expect(negate.modeled).toBe(true);
    expect(negate.spellAbility?.targets).toEqual([{ kind: 'noncreatureSpell', controller: 'opponent' }]);
  });

  it('destroys target with an arbitrary permanent-type alternation not in the fixed compound list', () => {
    const mortify = interpretCard(
      oracle({
        name: 'Mortify Test',
        typeLine: 'Instant',
        manaCost: '{1}{W}{B}',
        power: null,
        toughness: null,
        oracleText: 'Destroy target creature or enchantment.',
      }),
    );
    expect(mortify.modeled).toBe(true);
    expect(mortify.spellAbility?.effects).toEqual([{ op: 'destroy', target: 0 }]);
    expect(mortify.spellAbility?.targets).toEqual([
      {
        kind: 'permanent',
        filter: { kind: 'anyOf', of: [{ kind: 'type', value: 'Creature' }, { kind: 'type', value: 'Enchantment' }] },
      },
    ]);
  });

  it('models "destroy target X, its controller creates a token" as one combined effect', () => {
    const pongify = interpretCard(
      oracle({
        name: 'Pongify Test',
        typeLine: 'Instant',
        manaCost: '{U}',
        power: null,
        toughness: null,
        oracleText: "Destroy target creature. It can't be regenerated. Its controller creates a 3/3 green Ape creature token.",
      }),
    );
    expect(pongify.modeled).toBe(true);
    expect(pongify.spellAbility?.targets).toEqual([{ kind: 'creature' }]);
    expect(pongify.spellAbility?.effects).toEqual([
      {
        op: 'destroyAndCreateTokenForController',
        target: 0,
        count: { kind: 'const', n: 1 },
        spec: expect.objectContaining({ name: 'Ape', power: 3, toughness: 3, colors: ['G'] }),
      },
    ]);
  });

  it('models "you lose N life" and the "draw N, lose N life" cantrip shape', () => {
    const grasp = interpretCard(
      oracle({
        name: 'Grasp Test',
        typeLine: 'Instant',
        manaCost: '{1}{B}',
        power: null,
        toughness: null,
        oracleText: 'Destroy target creature. You lose 2 life.',
      }),
    );
    expect(grasp.modeled).toBe(true);
    expect(grasp.spellAbility?.effects).toEqual([
      { op: 'destroy', target: 0 },
      { op: 'loseLife', amount: { kind: 'const', n: 2 } },
    ]);

    const whisper = interpretCard(
      oracle({
        name: "Whisper Test",
        typeLine: 'Sorcery',
        manaCost: '{1}{B}',
        power: null,
        toughness: null,
        oracleText: 'You draw two cards and lose 2 life.',
      }),
    );
    expect(whisper.modeled).toBe(true);
    expect(whisper.spellAbility?.effects).toEqual([
      { op: 'draw', count: { kind: 'const', n: 2 } },
      { op: 'loseLife', amount: { kind: 'const', n: 2 } },
    ]);
  });

  it('tutors for an unrestricted card (Demonic Tutor)', () => {
    const tutor = interpretCard(
      oracle({
        name: 'Demonic Tutor Test',
        typeLine: 'Sorcery',
        manaCost: '{1}{B}',
        power: null,
        toughness: null,
        oracleText: 'Search your library for a card, put that card into your hand, then shuffle.',
      }),
    );
    expect(tutor.modeled).toBe(true);
    expect(tutor.spellAbility?.effects).toEqual([
      { op: 'searchLibrary', filter: { kind: 'allOf', of: [] }, destinations: [{ zone: 'hand' }] },
      { op: 'shuffle' },
    ]);
  });

  it('models the aristocrats drain trigger, targeted and each-opponent forms', () => {
    const bloodArtist = interpretCard(
      oracle({
        name: 'Blood Artist Test',
        typeLine: 'Creature — Vampire',
        manaCost: '{B}',
        power: '0',
        toughness: '1',
        oracleText: 'Whenever Blood Artist Test or another creature dies, target player loses 1 life and you gain 1 life.',
      }),
    );
    expect(bloodArtist.modeled).toBe(true);
    expect(bloodArtist.triggers?.[0]?.effects).toEqual([
      { op: 'loseLifeTarget', target: 0, amount: { kind: 'const', n: 1 } },
      { op: 'gainLife', amount: { kind: 'const', n: 1 } },
    ]);
    expect(bloodArtist.triggers?.[0]?.targets).toEqual([{ kind: 'player' }]);

    const zulaport = interpretCard(
      oracle({
        name: 'Zulaport Test',
        typeLine: 'Creature — Human Cleric',
        manaCost: '{1}{B}',
        power: '1',
        toughness: '1',
        oracleText: 'Whenever Zulaport Test or another creature you control dies, each opponent loses 1 life and you gain 1 life.',
      }),
    );
    expect(zulaport.modeled).toBe(true);
    expect(zulaport.triggers?.[0]?.effects).toEqual([
      { op: 'eachOpponentLosesLife', amount: 1 },
      { op: 'gainLife', amount: { kind: 'const', n: 1 } },
    ]);
  });

  it('draws cards equal to the greatest power among a negated-tribe subject', () => {
    const wildspeaker = interpretCard(
      oracle({
        name: 'Wildspeaker Test',
        typeLine: 'Sorcery',
        manaCost: '{3}{G}{G}',
        power: null,
        toughness: null,
        oracleText: 'Choose one —\n• Draw cards equal to the greatest power among non-Human creatures you control.\n• Non-Human creatures you control get +3/+3 until end of turn.',
      }),
    );
    expect(wildspeaker.modeled).toBe(true);
    const drawMode = wildspeaker.spellAbility?.modes?.options[0];
    expect(drawMode?.effects).toEqual([
      {
        op: 'draw',
        count: {
          kind: 'greatestPowerAmong',
          selector: {
            kind: 'allOf',
            of: [
              { kind: 'controller', who: 'you' },
              { kind: 'not', of: { kind: 'subtype', value: 'Human' } },
              { kind: 'type', value: 'Creature' },
            ],
          },
          scope: 'all',
        },
      },
    ]);
  });

  it('treats "choose two" as an exact count, unlike "choose one or more"', () => {
    const austereCommand = interpretCard(
      oracle({
        name: 'Austere Command Test 2',
        typeLine: 'Sorcery',
        manaCost: '{4}{W}{W}',
        power: null,
        toughness: null,
        oracleText:
          'Choose two —\n• Destroy all artifacts.\n• Destroy all enchantments.\n• Destroy all creatures with mana value 3 or less.\n• Destroy all creatures with mana value 4 or greater.',
      }),
    );
    expect(austereCommand.modeled).toBe(true);
    expect(austereCommand.spellAbility?.modes?.minChoices).toBe(2);
    expect(austereCommand.spellAbility?.modes?.maxChoices).toBe(2);
  });

  it('models self-pump activated abilities (~ gets +1/+0 until end of turn)', () => {
    const firebreather = interpretCard(
      oracle({
        name: 'Fire Dragon',
        typeLine: 'Creature — Dragon',
        manaCost: '{2}{R}',
        power: '2',
        toughness: '2',
        oracleText: '{R}: ~ gets +1/+0 until end of turn.',
      }),
    );
    expect(firebreather.modeled).toBe(true);
    expect(firebreather.activatedAbilities?.length).toBe(1);
    expect(firebreather.activatedAbilities?.[0]?.ability.effects).toEqual([
      { op: 'pumpEachUntilEot', selector: { kind: 'self' }, power: 1, toughness: 0 },
    ]);
  });
});
