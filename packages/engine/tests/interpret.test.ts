import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { allOf, ofType, YOURS } from '../src/cards/selector';
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

    const cascade = interpretCard(oracle({ name: 'Cascade Creature', oracleText: 'Cascade' }));
    expect(cascade.modeled).toBe(true);
    expect(cascade.keywords).toContain('cascade');
    const rebound = interpretCard(
      oracle({
        name: 'Rebound Spell',
        typeLine: 'Sorcery',
        oracleText: 'Draw a card.' + String.fromCharCode(10) + 'Rebound',
      }),
    );
    expect(rebound.modeled).toBe(true);
    expect(rebound.keywords).toContain('rebound');
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
    const def = interpretCard(
      oracle({
        name: 'Test Tower',
        typeLine: 'Land',
        manaCost: null,
        power: null,
        toughness: null,
        oracleText: 'You have no maximum hand size.\n{T}: Add {C}.',
      }),
    );
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

  it('reads "two mana of any ONE color" as linked units, never two independent colors', () => {
    // Two units each offering all five colors would let one tap pay {W}{U}, which this land
    // cannot do — the symbols are LINKED. `linked` makes the payment solver assign every unit
    // the same color (coverage PR02; behavior pinned by the Sceptre of Eternal Glory tests).
    const def = manaLand('{T}: Add two mana of any one color.');

    expect(def.modeled).toBe(true);
    const any = ['W', 'U', 'B', 'R', 'G'];
    expect(def.manaAbilities).toEqual([{ units: [any, any], linked: true }]);
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
    expect(def.spellAbility?.effects).toEqual([
      { op: 'dealDamage', target: 0, amount: { kind: 'const', n: 3 } },
    ]);
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
    expect(b.spellAbility?.effects).toEqual([
      { op: 'dealDamage', target: 0, amount: { kind: 'const', n: 3 } },
    ]);
    expect(b.spellAbility?.targets).toEqual([{ kind: 'anyTarget' }]);

    expect(interpretCard(doom()).spellAbility?.effects).toEqual([{ op: 'destroy', target: 0 }]);
    expect(interpretCard(cancel()).spellAbility?.effects).toEqual([{ op: 'counter', target: 0 }]);
    expect(interpretCard(divination()).spellAbility?.effects).toEqual([
      { op: 'draw', count: { kind: 'const', n: 2 } },
    ]);
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

  it('models Phyrexian mana costs', () => {
    const def = interpretCard(oracle({ name: 'Phyrexian', manaCost: '{G/P}' }));
    expect(def.modeled).toBe(true);
    expect(def.hasUnsupportedCost).toBe(false);
    expect(def.manaCost?.phyrexian).toEqual(['G']);
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
    expect(vandalblast.spellAbility?.effects).toEqual([{ op: 'destroy', target: 0 }]);
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
    expect(vanishingVerse.spellAbility?.effects).toEqual([{ op: 'exile', target: 0 }]);
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
    expect(fracture.spellAbility?.targets).toEqual([{ kind: 'artifactEnchantmentOrPlaneswalker' }]);
  });

  it('models a signet as a mana ability and a ritual as a spell effect', () => {
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
    // A signet is a MANA ability (CR 605.1a — the rule constrains the effect, not the cost), so
    // it never uses the stack and the payment solver can reach for it. The {1} is charged.
    expect(signet.modeled).toBe(true);
    expect(signet.activatedAbilities).toHaveLength(0);
    expect(signet.manaAbilities?.[0]?.costs).toEqual([
      { kind: 'mana', cost: expect.objectContaining({ generic: 1 }) },
      { kind: 'tap' },
    ]);
    expect(signet.manaAbilities?.[0]?.units).toEqual([['U'], ['B']]);

    // The ritual half is unchanged: "Add {B}{B}{B}" printed as a SPELL is a spell effect, not a
    // mana ability, because a spell is not an ability at all.

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
    expect(negate.spellAbility?.targets).toEqual([
      { kind: 'noncreatureSpell', controller: 'opponent' },
    ]);
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
        filter: {
          kind: 'anyOf',
          of: [
            { kind: 'type', value: 'Creature' },
            { kind: 'type', value: 'Enchantment' },
          ],
        },
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
        oracleText:
          "Destroy target creature. It can't be regenerated. Its controller creates a 3/3 green Ape creature token.",
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
        name: 'Whisper Test',
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

  it('parses revealed tutors that shuffle and put the card on top', () => {
    const tutor = interpretCard(
      oracle({
        name: 'Top Tutor Test',
        typeLine: 'Instant',
        manaCost: '{U}',
        power: null,
        toughness: null,
        oracleText:
          'Search your library for an artifact or enchantment card, reveal it, then shuffle and put that card on top.',
      }),
    );
    expect(tutor.modeled).toBe(true);
    // The shuffle comes FIRST. "…then shuffle and put that card on top" is the printed order,
    // and it is the order that matters: shuffling afterwards would bury the card the spell
    // exists to set up. Which card is chosen cannot depend on the shuffle, so asking first and
    // shuffling first are the same decision.
    expect(tutor.spellAbility?.effects).toEqual([
      { op: 'shuffle' },
      {
        op: 'searchLibrary',
        filter: {
          kind: 'anyOf',
          of: [
            { kind: 'type', value: 'Artifact' },
            { kind: 'type', value: 'Enchantment' },
          ],
        },
        destinations: [{ zone: 'libraryTop' }],
      },
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
        oracleText:
          'Whenever Blood Artist Test or another creature dies, target player loses 1 life and you gain 1 life.',
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
        oracleText:
          'Whenever Zulaport Test or another creature you control dies, each opponent loses 1 life and you gain 1 life.',
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
        oracleText:
          'Choose one —\n• Draw cards equal to the greatest power among non-Human creatures you control.\n• Non-Human creatures you control get +3/+3 until end of turn.',
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

  it('keeps a compound permanent-type mass effect inside one modal mode', () => {
    const cleansingNova = interpretCard(
      oracle({
        name: 'Cleansing Nova Test',
        typeLine: 'Sorcery',
        manaCost: '{3}{W}{W}',
        power: null,
        toughness: null,
        oracleText:
          'Choose one —\n• Destroy all creatures.\n• Destroy all artifacts and enchantments.',
      }),
    );
    expect(cleansingNova.modeled).toBe(true);
    expect(cleansingNova.spellAbility?.modes?.options[1]?.effects).toEqual([
      {
        op: 'destroyEach',
        selector: {
          kind: 'anyOf',
          of: [
            { kind: 'type', value: 'Artifact' },
            { kind: 'type', value: 'Enchantment' },
          ],
        },
      },
    ]);
  });
  it('keeps a two-target destruction clause inside one modal mode', () => {
    const hullBreach = interpretCard(
      oracle({
        name: 'Hull Breach Test',
        typeLine: 'Sorcery',
        manaCost: '{G}{R}',
        power: null,
        toughness: null,
        oracleText:
          'Choose one —\n• Destroy target artifact.\n• Destroy target enchantment.\n• Destroy target artifact and target enchantment.',
      }),
    );
    expect(hullBreach.modeled).toBe(true);
    expect(hullBreach.spellAbility?.targets).toEqual([
      { kind: 'artifact' },
      { kind: 'enchantment' },
      { kind: 'artifact' },
      { kind: 'enchantment' },
    ]);
    expect(hullBreach.spellAbility?.modes?.options[2]?.effects).toEqual([
      { op: 'destroy', target: 2 },
      { op: 'destroy', target: 3 },
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

  it('reads a lowercase "this <type>" at the start of a trigger body as a self-reference', () => {
    const tremors = interpretCard(
      oracle({
        name: 'Impact Tremors Test',
        typeLine: 'Enchantment',
        manaCost: '{1}{R}',
        power: null,
        toughness: null,
        oracleText:
          'Whenever a creature you control enters, this enchantment deals 1 damage to each opponent.',
      }),
    );
    expect(tremors.modeled).toBe(true);
    expect(tremors.triggers?.[0]?.effects).toEqual([{ op: 'eachOpponentDamage', amount: 1 }]);

    // A lowercase "this creature" that is NOT the leading word of the trigger body is a
    // back-reference to an object the body itself already introduced ("target creature"), not
    // to the source — only the leading word is eligible for the self-reference rewrite.
    const backReference = interpretCard(
      oracle({
        name: 'Back Reference Test',
        typeLine: 'Enchantment',
        manaCost: '{2}{U}',
        power: null,
        toughness: null,
        oracleText:
          "Whenever a creature you control enters, exile target creature, then return this creature to its owner's hand.",
      }),
    );
    expect(backReference.modeled).toBe(false);
  });

  it('filters spell triggers by "noncreature" and "instant or sorcery"', () => {
    const noncreature = interpretCard(
      oracle({
        name: 'Noncreature Trigger Test',
        typeLine: 'Enchantment',
        manaCost: '{1}{U}',
        power: null,
        toughness: null,
        oracleText: 'Whenever you cast a noncreature spell, draw a card.',
      }),
    );
    expect(noncreature.modeled).toBe(true);
    expect(noncreature.triggers?.[0]?.trigger).toMatchObject({
      when: 'castsSpell',
      caster: 'you',
      filter: { kind: 'not', of: { kind: 'type', value: 'Creature' } },
    });

    const instantOrSorcery = interpretCard(
      oracle({
        name: 'Instant Sorcery Trigger Test',
        typeLine: 'Creature — Human Wizard',
        manaCost: '{2}{U}',
        power: '2',
        toughness: '3',
        oracleText: 'Whenever you cast an instant or sorcery spell, draw a card.',
      }),
    );
    expect(instantOrSorcery.modeled).toBe(true);
    expect(instantOrSorcery.triggers?.[0]?.trigger).toMatchObject({
      when: 'castsSpell',
      caster: 'you',
      filter: {
        kind: 'anyOf',
        of: [
          { kind: 'type', value: 'Instant' },
          { kind: 'type', value: 'Sorcery' },
        ],
      },
    });
  });

  it('reads a mass-destroy/exile subject qualified by mana value or a controller suffix', () => {
    const despark = interpretCard(
      oracle({
        name: 'Despark Test',
        typeLine: 'Instant',
        manaCost: '{1}{W}{B}',
        power: null,
        toughness: null,
        oracleText: 'Exile target permanent with mana value 4 or greater.',
      }),
    );
    expect(despark.modeled).toBe(true);
    expect(despark.spellAbility?.targets).toEqual([
      { kind: 'permanent', filter: { kind: 'manaValueAtLeast', n: 4 } },
    ]);
    expect(despark.spellAbility?.effects).toEqual([{ op: 'exile', target: 0 }]);

    const abruptDecay = interpretCard(
      oracle({
        name: 'Abrupt Decay Test',
        typeLine: 'Instant',
        manaCost: '{B}{G}',
        power: null,
        toughness: null,
        oracleText: 'Destroy target nonland permanent with mana value 3 or less.',
      }),
    );
    expect(abruptDecay.modeled).toBe(true);
    expect(abruptDecay.spellAbility?.targets).toEqual([
      { kind: 'nonlandPermanent', filter: { kind: 'manaValueAtMost', n: 3 } },
    ]);

    const ruinous = interpretCard(
      oracle({
        name: 'Ruinous Ultimatum Test',
        typeLine: 'Sorcery',
        manaCost: '{3}{B}{B}{R}{R}',
        power: null,
        toughness: null,
        oracleText: 'Destroy all nonland permanents your opponents control.',
      }),
    );
    expect(ruinous.modeled).toBe(true);
    expect(ruinous.spellAbility?.effects).toEqual([
      {
        op: 'destroyEach',
        selector: {
          kind: 'allOf',
          of: [
            { kind: 'controller', who: 'opponents' },
            { kind: 'not', of: { kind: 'type', value: 'Land' } },
          ],
        },
      },
    ]);
  });

  it('attaches "a creature destroyed this way can\'t be regenerated" to destruction', () => {
    const damn = interpretCard(
      oracle({
        name: 'Damn Test',
        typeLine: 'Instant',
        manaCost: '{1}{W}{B}',
        power: null,
        toughness: null,
        oracleText: "Destroy target creature. A creature destroyed this way can't be regenerated.",
      }),
    );
    expect(damn.modeled).toBe(true);
    expect(damn.spellAbility?.effects).toEqual([
      { op: 'destroy', target: 0, cantRegenerate: true },
    ]);
  });

  it('reads a plain, unconditional cost reduction by type or by color', () => {
    const electromancer = interpretCard(
      oracle({
        name: 'Electromancer Test',
        typeLine: 'Creature — Goblin Wizard',
        manaCost: '{1}{U}',
        power: '2',
        toughness: '1',
        oracleText: 'Instant and sorcery spells you cast cost {1} less to cast.',
      }),
    );
    expect(electromancer.modeled).toBe(true);
    expect(electromancer.ruleStatics).toEqual([
      {
        kind: 'costReduction',
        amount: { kind: 'const', n: 1 },
        filter: {
          kind: 'anyOf',
          of: [
            { kind: 'type', value: 'Instant' },
            { kind: 'type', value: 'Sorcery' },
          ],
        },
      },
    ]);

    const anarchomancer = interpretCard(
      oracle({
        name: 'Anarchomancer Test',
        typeLine: 'Creature — Goblin Shaman',
        manaCost: '{R}',
        power: '1',
        toughness: '1',
        oracleText: "Each spell you cast that's red or green costs {1} less to cast.",
      }),
    );
    expect(anarchomancer.modeled).toBe(true);
    expect(anarchomancer.ruleStatics).toEqual([
      {
        kind: 'costReduction',
        amount: { kind: 'const', n: 1 },
        filter: {
          kind: 'anyOf',
          of: [
            { kind: 'color', value: 'R' },
            { kind: 'color', value: 'G' },
          ],
        },
      },
    ]);
  });

  it('refuses a modal DFC land face printing anything beyond the plain mana ability', () => {
    // Guards against silently dropping a real clause: a Pathway-shaped detector that fired on
    // any two-land-face DFC, ignoring extra text, would be exactly the over-permissive modeling
    // this engine's contract refuses (brief §6.3).
    const def = interpretCard(
      oracle({
        name: 'Test Pathway With Extra Text',
        typeLine: 'Land',
        manaCost: null,
        power: null,
        toughness: null,
        layout: 'modal_dfc',
        oracleText: '{T}: Add {B}.',
        backFace: {
          name: 'Test Back',
          typeLine: 'Land',
          oracleText: 'This land enters tapped.\n{T}: Add {R}.',
          manaCost: null,
          colors: [],
          power: null,
          toughness: null,
        },
      } as never),
    );
    expect(def.modeled).toBe(false);
    expect(def.entersChoosingOption).toBeUndefined();
    expect(def.unmodeledReasons.some((r) => r.includes('unsupported layout'))).toBe(true);
  });

  it('reads the commander-free-cast line as a top-level flag', () => {
    const flawless = interpretCard(
      oracle({
        name: 'Flawless Maneuver Test',
        typeLine: 'Instant',
        manaCost: '{3}{W}',
        power: null,
        toughness: null,
        oracleText:
          'If you control a commander, you may cast this spell without paying its mana cost.\nCreatures you control gain indestructible until end of turn.',
      }),
    );
    expect(flawless.modeled).toBe(true);
    expect(flawless.commanderFreeCast).toBe(true);
    expect(flawless.spellAbility?.effects).toEqual([
      {
        op: 'grantKeywordEachUntilEot',
        selector: {
          kind: 'allOf',
          of: [
            { kind: 'controller', who: 'you' },
            { kind: 'type', value: 'Creature' },
          ],
        },
        keyword: 'indestructible',
      },
    ]);
  });

  it('reads "cast or copy" onto the same castsSpell trigger head as plain "cast"', () => {
    const archmage = interpretCard(
      oracle({
        name: 'Archmage Emeritus Test',
        typeLine: 'Creature — Human Wizard',
        manaCost: '{2}{U}',
        power: '2',
        toughness: '3',
        oracleText: 'Whenever you cast or copy an instant or sorcery spell, draw a card.',
      }),
    );
    expect(archmage.modeled).toBe(true);
    expect(archmage.triggers[0]?.trigger).toMatchObject({ when: 'castsSpell', caster: 'you' });
    expect(archmage.triggers[0]?.effects).toEqual([{ op: 'draw', count: { kind: 'const', n: 1 } }]);
  });

  it('reads the attack-tax static (Ghostly Prison, Propaganda)', () => {
    const propaganda = interpretCard(
      oracle({
        name: 'Propaganda Test',
        typeLine: 'Enchantment',
        manaCost: '{2}{U}',
        power: null,
        toughness: null,
        oracleText:
          "Creatures can't attack you unless their controller pays {2} for each creature they control that's attacking you.",
      }),
    );
    expect(propaganda.modeled).toBe(true);
    expect(propaganda.ruleStatics).toEqual([{ kind: 'attackTax', amount: 2 }]);
  });

  it('reads the singular possessive bounce template ("its owner\'s hand"), not just the plural', () => {
    const snap = interpretCard(
      oracle({
        name: 'Snap Test',
        typeLine: 'Instant',
        manaCost: '{1}{U}',
        power: null,
        toughness: null,
        oracleText: "Return target creature to its owner's hand.",
      }),
    );
    expect(snap.modeled).toBe(true);
    expect(snap.spellAbility?.effects).toEqual([{ op: 'returnToHand', target: 0 }]);
    expect(snap.spellAbility?.targets).toEqual([{ kind: 'creature' }]);

    const nonland = interpretCard(
      oracle({
        name: 'Nonland Bounce Test',
        typeLine: 'Instant',
        manaCost: '{1}{U}',
        power: null,
        toughness: null,
        oracleText: "Return target nonland permanent to its owner's hand.",
      }),
    );
    expect(nonland.modeled).toBe(true);
    expect(nonland.spellAbility?.effects).toEqual([{ op: 'returnToHand', target: 0 }]);
    expect(nonland.spellAbility?.targets).toEqual([{ kind: 'nonlandPermanent' }]);

    // The plural possessive this rule already handled, unchanged.
    const massReturn = interpretCard(
      oracle({
        name: 'Mass Return Test',
        typeLine: 'Sorcery',
        manaCost: '{3}{U}',
        power: null,
        toughness: null,
        oracleText: "Return all artifacts to their owners' hands.",
      }),
    );
    expect(massReturn.modeled).toBe(true);
    expect(massReturn.spellAbility?.effects).toEqual([
      { op: 'returnToHandEach', selector: { kind: 'type', value: 'Artifact' } },
    ]);
  });

  it('splits conservative compound effects only when both halves parse', () => {
    const def = interpretCard(
      oracle({
        name: 'Compound Removal',
        typeLine: 'Sorcery',
        power: null,
        toughness: null,
        oracleText: 'Destroy target artifact and draw a card.',
      }),
    );
    expect(def.modeled).toBe(true);
    expect(def.spellAbility?.targets).toEqual([{ kind: 'artifact' }]);
    expect(def.spellAbility?.effects).toEqual([
      { op: 'destroy', target: 0 },
      { op: 'draw', count: { kind: 'const', n: 1 } },
    ]);

    const coordinatedNouns = interpretCard(
      oracle({
        name: 'Coordinated Nouns',
        typeLine: 'Sorcery',
        power: null,
        toughness: null,
        oracleText: 'Destroy all artifacts and enchantments.',
      }),
    );
    expect(coordinatedNouns.modeled).toBe(true);
    expect(coordinatedNouns.spellAbility?.effects).toEqual([
      {
        op: 'destroyEach',
        selector: {
          kind: 'anyOf',
          of: [
            { kind: 'type', value: 'Artifact' },
            { kind: 'type', value: 'Enchantment' },
          ],
        },
      },
    ]);
  });
  it('scopes counter-qualified static keywords to the matching creatures', () => {
    const def = interpretCard(
      oracle({
        name: 'Counter Captain',
        typeLine: 'Creature',
        oracleText: 'Each creature you control with a +1/+1 counter on it has trample.',
      }),
    );
    expect(def.modeled).toBe(true);
    // The subject names the counter KIND. Reading it as "any counter" is not a harmless
    // widening — a creature carrying only a -1/-1 counter, which is what persist gives back,
    // would qualify. See marchesa-the-black-rose.test.ts for what that costs behaviourally.
    expect(def.staticEffects[0]).toMatchObject({
      affects: {
        kind: 'allOf',
        of: expect.arrayContaining([
          { kind: 'hasCounter', counter: '+1/+1' },
          { kind: 'controller', who: 'you' },
          { kind: 'type', value: 'Creature' },
        ]),
      },
      op: { layer: 6, addKeyword: 'trample' },
    });
  });
  it('models dynamic count values across P/T, counters, and combat triggers', () => {
    const shanna = interpretCard(
      oracle({
        name: 'Count Shanna',
        typeLine: 'Legendary Creature',
        oracleText: '~ gets +1/+1 for each creature you control.',
      }),
    );
    expect(shanna.modeled).toBe(true);
    expect(shanna.staticEffects[0]?.op).toMatchObject({
      power: { kind: 'times', n: 1, of: { kind: 'countPermanents', scope: 'you' } },
      toughness: { kind: 'times', n: 1, of: { kind: 'countPermanents', scope: 'you' } },
    });

    const chauffeur = interpretCard(
      oracle({
        name: "Count Boss's Chauffeur",
        typeLine: 'Creature',
        oracleText:
          'This creature enters with a number of +1/+1 counters on it equal to one plus the number of other creatures you control.',
      }),
    );
    expect(chauffeur.modeled).toBe(true);
    expect(chauffeur.entersWithCounters?.['+1/+1']).toMatchObject({
      kind: 'plus',
      n: 1,
      of: { kind: 'countPermanents', scope: 'you' },
    });

    const kinbinding = interpretCard(
      oracle({
        name: 'Count Kinbinding',
        typeLine: 'Enchantment',
        power: null,
        toughness: null,
        oracleText:
          'Creatures you control get +X/+X, where X is the number of creatures that entered the battlefield under your control this turn.\nAt the beginning of combat on your turn, create a 1/1 green and white Kithkin creature token.',
      }),
    );
    expect(kinbinding.modeled).toBe(true);
    expect(kinbinding.triggers[0]?.trigger).toMatchObject({
      when: 'beginningOfCombat',
      player: 'you',
    });
  });

  it('models combat restrictions and per-opponent attacking tokens', () => {
    const basandra = interpretCard(
      oracle({
        name: 'Count Basandra',
        typeLine: 'Legendary Creature — Angel',
        oracleText:
          "Flying\nPlayers can't cast spells during combat.\n{R}: Target creature attacks this turn if able.",
      }),
    );
    expect(basandra.modeled).toBe(true);
    // "PLAYERS can't cast spells during combat" — Basandra binds its own controller too, unlike
    // Marisi's "your opponents can't cast spells during combat".
    expect(basandra.ruleStatics).toContainEqual({
      kind: 'cantCastSpells',
      who: 'all',
      yourTurnOnly: false,
      duringCombatOnly: true,
    });

    const adeline = interpretCard(
      oracle({
        name: 'Count Adeline',
        typeLine: 'Legendary Creature — Human Soldier',
        oracleText:
          "Whenever you attack, for each opponent, create a 1/1 white Human creature token that's tapped and attacking that player.",
      }),
    );
    expect(adeline.modeled).toBe(true);
    expect(adeline.triggers[0]?.effects[0]).toMatchObject({
      op: 'createTokenForEachOpponent',
      attacking: true,
      spec: { name: 'Human', power: 1, toughness: 1 },
    });
    // "Whenever YOU attack" fires on the declaration, not on this creature attacking: it is the
    // aggregate form over your attacking creatures, so it triggers with Adeline left at home.
    expect(adeline.triggers[0]?.trigger).toEqual({
      when: 'attacks',
      subject: {
        kind: 'permanent',
        selector: allOf(ofType('Creature'), YOURS),
      },
      aggregate: true,
    });
  });
  it('models a creature whose static ability makes itself unblockable', () => {
    const unblockable = interpretCard(
      oracle({
        name: 'Unblockable Test',
        typeLine: 'Creature — Illusion',
        manaCost: '{2}{U}',
        power: '2',
        toughness: '2',
        oracleText: "~ can't be blocked.",
      }),
    );
    expect(unblockable.modeled).toBe(true);
    expect(unblockable.staticEffects).toEqual([
      { affects: { kind: 'self' }, op: { layer: 6, setCantBeBlocked: true } },
    ]);
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

  it('announces ONE target for "target creature gets +N/+N and gains <keyword>"', () => {
    // CR 601.2c: the spell announces the targets its text names, and this text names one
    // "target creature". Two slots would let the pump and the keyword land on different
    // creatures — the printed card buffs a single creature. ~170 printed cards use this form.
    const def = interpretCard(
      oracle({
        name: 'Tread Upon Test',
        typeLine: 'Instant',
        power: null,
        toughness: null,
        oracleText: 'Target creature gets +2/+2 and gains trample until end of turn.',
      }),
    );
    expect(def.modeled).toBe(true);
    expect(def.spellAbility?.targets).toEqual([{ kind: 'creature' }]);
    expect(def.spellAbility?.effects).toEqual([
      { op: 'pumpUntilEot', target: 0, power: 2, toughness: 2 },
      { op: 'grantKeywordUntilEot', target: 0, keyword: 'trample' },
    ]);
  });

  it('keeps every ability on an Aura whose line ends "and is goaded"', () => {
    // The goad rider is the LAST clause of a line that also grants real abilities. Reading the
    // whole prefix as a "subject" would report the card modeled while dropping them silently.
    const ghoulish = interpretCard(
      oracle({
        name: 'Ghoulish Test',
        typeLine: 'Enchantment — Aura',
        power: null,
        toughness: null,
        oracleText:
          'Enchant creature\nEnchanted creature gets +1/+1, has deathtouch, and is goaded.',
      }),
    );
    expect(ghoulish.modeled).toBe(true);
    expect(ghoulish.staticEffects).toEqual([
      {
        affects: { kind: 'attachedToSource' },
        op: { layer: 7, sublayer: 'd', power: 1, toughness: 1 },
      },
      { affects: { kind: 'attachedToSource' }, op: { layer: 6, addKeyword: 'deathtouch' } },
      { affects: { kind: 'attachedToSource' }, op: { layer: 6, addGoad: true } },
    ]);

    const indestructible = interpretCard(
      oracle({
        name: 'Redemption Test',
        typeLine: 'Enchantment — Aura',
        power: null,
        toughness: null,
        oracleText: 'Enchant creature\nEnchanted creature has indestructible and is goaded.',
      }),
    );
    expect(indestructible.staticEffects).toEqual([
      { affects: { kind: 'attachedToSource' }, op: { layer: 6, addKeyword: 'indestructible' } },
      { affects: { kind: 'attachedToSource' }, op: { layer: 6, addGoad: true } },
    ]);

    // A prefix the grammar cannot read must leave the whole line unmodeled rather than ship the
    // goad on its own.
    const unreadable = interpretCard(
      oracle({
        name: 'Unreadable Test',
        typeLine: 'Enchantment — Aura',
        power: null,
        toughness: null,
        oracleText:
          'Enchant creature\nEnchanted creature gets +3/+3, must be blocked if able, and is goaded.',
      }),
    );
    expect(unreadable.modeled).toBe(false);
    expect(unreadable.staticEffects ?? []).toEqual([]);
  });

  it('scopes "for each" counts to the subject that was printed', () => {
    // Counting an explicitly opposing subject under a you-only scope yields a constant 0, with
    // the card still reporting modeled.
    const opposing = interpretCard(
      oracle({
        name: 'Opposing Count Test',
        typeLine: 'Creature — Test',
        power: '1',
        toughness: '1',
        oracleText: '~ gets +1/+0 for each creature your opponents control.',
      }),
    );
    expect(opposing.modeled).toBe(true);
    const op = opposing.staticEffects?.[0]?.op;
    expect(op !== undefined && 'power' in op ? op.power : null).toMatchObject({
      kind: 'times',
      of: { kind: 'countPermanents', scope: 'opponents' },
    });
  });
});
