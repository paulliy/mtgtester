/**
 * Anthems and lords (ADR 0008) — the most common static ability in Commander, and the reason
 * `Selector` became a compositional grammar rather than a closed list of named sets.
 *
 * Two rules are load-bearing here and are tested against their *wrong* answers:
 *   - a static ability re-derives its affected set on every layer pass, against CURRENT
 *     characteristics, so an animated land is caught by "creatures you control";
 *   - CR 611.2c: an until-end-of-turn effect from a RESOLVED SPELL fixes its set once, at
 *     resolution, and never re-derives it. A creature entering later is not pumped.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition } from '../src/cards/definition';
import { interpretCard } from '../src/cards/interpret';
import { OTHER, YOURS, allOf, ofColor, ofSubtype, ofType } from '../src/cards/selector';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { effectivePT, hasKeyword } from '../src/state/queries';
import type { EnginePermanent, GameContext } from '../src/state/types';
import {
  bear,
  copies,
  forest,
  gameConfig,
  oracle,
  pump,
  registerCustomDef,
  spawn,
} from './fixtures';

function ctx4(): GameContext {
  const c = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(2, forest) })),
      { seed: 'anthems' },
    ),
  );
  c.state.currentTurnPlayer = 'P1';
  c.state.turnNumber = 3;
  return c;
}

/** A vanilla creature of the given subtype, so lords have something to look at. */
const tribal = (name: string, subtype: string, pt = '1/1'): ReturnType<typeof oracle> => {
  const [p, t] = pt.split('/') as [string, string];
  return oracle({
    name,
    typeLine: `Creature — ${subtype}`,
    manaCost: '{1}{G}',
    power: p,
    toughness: t,
  });
};

const pt = (ctx: GameContext, perm: EnginePermanent): string => {
  const { power, toughness } = effectivePT(ctx, perm);
  return `${power}/${toughness}`;
};

describe('anthems and lords (ADR 0008)', () => {
  it('"Creatures you control get +1/+1" buffs only its controller\'s creatures', () => {
    const anthem = oracle({
      name: 'Test Anthem',
      typeLine: 'Enchantment',
      manaCost: '{1}{W}',
      power: null,
      toughness: null,
      oracleText: 'Creatures you control get +1/+1.',
    });
    expect(interpretCard(anthem).modeled).toBe(true);

    const ctx = ctx4();
    const mine = spawn(ctx, 'P1', bear());
    const theirs = spawn(ctx, 'P2', bear());
    expect(pt(ctx, mine)).toBe('2/2');

    spawn(ctx, 'P1', anthem);
    // The controller clause is the whole point: without it both would be 3/3.
    expect(pt(ctx, mine)).toBe('3/3');
    expect(pt(ctx, theirs)).toBe('2/2');
  });

  it('a lord scopes by tribe, by controller, and excludes itself', () => {
    // Elvish Archdruid's shape. "Elves" resolves to the printed subtype "Elf" through the
    // card's own subtypes — the interpreter has no subtype dictionary (ADR 0008).
    const lord = oracle({
      name: 'Test Archdruid',
      typeLine: 'Creature — Elf Druid',
      manaCost: '{1}{G}{G}',
      power: '2',
      toughness: '2',
      oracleText: 'Other Elves you control get +1/+1 and have flying.',
    });
    const def = interpretCard(lord);
    expect(def.modeled).toBe(true);
    expect(def.staticEffects).toEqual([
      {
        affects: allOf(OTHER, YOURS, ofSubtype('Elf')),
        op: { layer: 7, sublayer: 'd', power: 1, toughness: 1 },
      },
      { affects: allOf(OTHER, YOURS, ofSubtype('Elf')), op: { layer: 6, addKeyword: 'flying' } },
    ]);

    const ctx = ctx4();
    const archdruid = spawn(ctx, 'P1', lord);
    const myElf = spawn(ctx, 'P1', tribal('Test Llanowar', 'Elf'));
    const myGoblin = spawn(ctx, 'P1', tribal('Test Goblin', 'Goblin'));
    const theirElf = spawn(ctx, 'P2', tribal('Test Their Elf', 'Elf'));

    expect(pt(ctx, myElf)).toBe('2/2');
    expect(hasKeyword(ctx, myElf, 'flying')).toBe(true);
    // "Other": the lord does not pump itself.
    expect(pt(ctx, archdruid)).toBe('2/2');
    expect(hasKeyword(ctx, archdruid, 'flying')).toBe(false);
    // Wrong tribe, and right tribe under the wrong controller.
    expect(pt(ctx, myGoblin)).toBe('1/1');
    expect(pt(ctx, theirElf)).toBe('1/1');
    expect(hasKeyword(ctx, theirElf, 'flying')).toBe(false);
  });

  it('"Creatures your opponents control get -1/-1" inverts the controller clause', () => {
    const curse = oracle({
      name: 'Test Curse',
      typeLine: 'Enchantment',
      manaCost: '{1}{B}',
      power: null,
      toughness: null,
      oracleText: 'Creatures your opponents control get -1/-1.',
    });
    expect(interpretCard(curse).modeled).toBe(true);

    const ctx = ctx4();
    const mine = spawn(ctx, 'P1', bear());
    const theirs = spawn(ctx, 'P2', bear());
    spawn(ctx, 'P1', curse);

    expect(pt(ctx, mine)).toBe('2/2');
    expect(pt(ctx, theirs)).toBe('1/1');
  });

  it('an anthem catches a land that layer 4 turned into a creature', () => {
    // The selector is evaluated against CURRENT characteristics inside the layer pass, so the
    // layer-4 animation (applied first) widens the layer-7d anthem's affected set. Reading
    // printed types instead would leave the manland at 2/2.
    const ctx = ctx4();
    registerCustomDef(ctx, {
      oracleId: 'manland',
      name: 'Test Manland',
      typeLine: 'Land',
      supertypes: [],
      types: ['Land'],
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
      triggers: [],
      staticEffects: [
        { affects: { kind: 'self' }, op: { layer: 4, addTypes: ['Creature'] } },
        {
          affects: { kind: 'self' },
          op: {
            layer: 7,
            sublayer: 'b',
            power: { kind: 'const', n: 2 },
            toughness: { kind: 'const', n: 2 },
          },
        },
      ],
      modeled: true,
      unmodeledReasons: [],
    } satisfies CardDefinition);
    const manland = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Test Manland',
        oracleId: 'manland',
        typeLine: 'Land',
        manaCost: null,
        power: null,
        toughness: null,
      }),
    );
    expect(pt(ctx, manland)).toBe('2/2');

    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Test Anthem',
        typeLine: 'Enchantment',
        manaCost: '{1}{W}',
        power: null,
        toughness: null,
        oracleText: 'Creatures you control get +1/+1.',
      }),
    );
    expect(pt(ctx, manland)).toBe('3/3');
  });
});

describe('CR 611.2c: a resolved spell fixes its affected set (ADR 0008)', () => {
  const overrun = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Test Overrun',
      typeLine: 'Sorcery',
      manaCost: '{2}{G}{G}{G}',
      power: null,
      toughness: null,
      oracleText: 'Creatures you control get +3/+3 and gain trample until end of turn.',
    });

  it('pumps the creatures present at resolution — and no one who arrives later', () => {
    const def = interpretCard(overrun());
    expect(def.modeled).toBe(true);
    // Untargeted: the subject is a selector, so the spell declares no target slots.
    expect(def.spellAbility?.targets).toEqual([]);
    expect(def.spellAbility?.effects).toEqual([
      {
        op: 'pumpEachUntilEot',
        selector: allOf(YOURS, ofType('Creature')),
        power: 3,
        toughness: 3,
      },
      {
        op: 'grantKeywordEachUntilEot',
        selector: allOf(YOURS, ofType('Creature')),
        keyword: 'trample',
      },
    ]);

    const ctx = ctx4();
    const present = spawn(ctx, 'P1', bear());
    const opponents = spawn(ctx, 'P2', bear());
    const caster = spawn(ctx, 'P1', overrun());

    pump(
      executeAbility(
        ctx,
        { cardId: caster.cardId, name: caster.name, oracleId: caster.oracleId, controllerId: 'P1' },
        def.spellAbility as NonNullable<typeof def.spellAbility>,
        [],
      ),
    );

    expect(pt(ctx, present)).toBe('5/5');
    expect(hasKeyword(ctx, present, 'trample')).toBe(true);
    expect(pt(ctx, opponents)).toBe('2/2');

    // A creature that enters AFTER the spell resolved is not in the locked-in set. A static
    // anthem would have caught it; a resolved spell's effect does not (CR 611.2c).
    const latecomer = spawn(ctx, 'P1', bear());
    expect(pt(ctx, latecomer)).toBe('2/2');
    expect(hasKeyword(ctx, latecomer, 'trample')).toBe(false);
  });

  it('the locked-in set is recorded by name, so the log shows what it caught', () => {
    const ctx = ctx4();
    spawn(ctx, 'P1', bear());
    const caster = spawn(ctx, 'P1', overrun());
    const def = interpretCard(overrun());

    pump(
      executeAbility(
        ctx,
        { cardId: caster.cardId, name: caster.name, oracleId: caster.oracleId, controllerId: 'P1' },
        def.spellAbility as NonNullable<typeof def.spellAbility>,
        [],
      ),
    );

    expect(ctx.state.effects.map((e) => e.description)).toEqual([
      'Test Bear get +3/+3 until end of turn',
      'Test Bear gain trample until end of turn',
    ]);
  });
});

describe('verbatim oracle text from printed cards (ADR 0008)', () => {
  // The point of the increment is real decks, so these are the exact strings Scryfall prints,
  // not paraphrases shaped to fit the regexes.
  it('parses the anthem line of real cards', () => {
    const cases: {
      name: string;
      typeLine: string;
      subtypes?: string[];
      colors?: ('W' | 'U' | 'B' | 'R' | 'G')[];
      text: string;
      affects: ReturnType<typeof allOf>;
    }[] = [
      {
        name: 'Glorious Anthem',
        typeLine: 'Enchantment',
        text: 'Creatures you control get +1/+1.',
        affects: allOf(YOURS, ofType('Creature')),
      },
      {
        name: 'Elvish Archdruid',
        typeLine: 'Creature — Elf Druid',
        subtypes: ['Elf', 'Druid'],
        text: 'Other Elves you control get +1/+1.',
        affects: allOf(OTHER, YOURS, ofSubtype('Elf')),
      },
      {
        name: 'Lord of the Undead',
        typeLine: 'Creature — Zombie Wizard',
        subtypes: ['Zombie', 'Wizard'],
        text: 'Other Zombies you control get +1/+1.',
        affects: allOf(OTHER, YOURS, ofSubtype('Zombie')),
      },
      {
        name: 'Bad Moon',
        typeLine: 'Enchantment',
        text: 'Black creatures get +1/+1.',
        affects: allOf(ofColor('B'), ofType('Creature')),
      },
    ];

    for (const c of cases) {
      const def = interpretCard(
        oracle({
          name: c.name,
          typeLine: c.typeLine,
          manaCost: '{1}{G}',
          ...(c.subtypes !== undefined ? { subtypes: c.subtypes } : {}),
          power: c.typeLine.includes('Creature') ? '2' : null,
          toughness: c.typeLine.includes('Creature') ? '2' : null,
          oracleText: c.text,
        }),
      );
      expect(def.unmodeledReasons, c.name).toEqual([]);
      expect(def.staticEffects, c.name).toEqual([
        { affects: c.affects, op: { layer: 7, sublayer: 'd', power: 1, toughness: 1 } },
      ]);
    }
  });

  it('accounts for the anthem line even when another line of the card is unmodeled', () => {
    // Elvish Archdruid's second line is an activated mana ability with a count — not modeled.
    // The card is correctly unmodeled overall, but the reason list names only that line, which
    // is how we know the anthem line was actually accounted for rather than swept up with it.
    const def = interpretCard(
      oracle({
        name: 'Elvish Archdruid',
        typeLine: 'Creature — Elf Druid',
        subtypes: ['Elf', 'Druid'],
        manaCost: '{1}{G}{G}',
        power: '2',
        toughness: '2',
        oracleText: 'Other Elves you control get +1/+1.\n{T}: Add {G} for each Elf you control.',
      }),
    );
    expect(def.modeled).toBe(false);
    expect(def.unmodeledReasons).toEqual([
      'unrecognized rules text: "{T}: Add {G} for each Elf you control."',
    ]);
    expect(def.staticEffects).toHaveLength(1);
  });
});

describe('the interpreter halts rather than guess a tribe (ADR 0008)', () => {
  it("resolves a tribe the card is not a member of, from CR 205.3m's closed list", () => {
    // "Slivers" → the printed subtype "Sliver" on a card that is not a Sliver. The vocabulary
    // is the rules' own complete creature-type list, so this is a lookup, not a guess.
    const def = interpretCard(
      oracle({
        name: 'Test Hivestone',
        typeLine: 'Artifact',
        manaCost: '{2}',
        power: null,
        toughness: null,
        oracleText: 'Slivers you control get +1/+1.',
      }),
    );
    expect(def.modeled).toBe(true);
    expect(def.staticEffects[0]?.affects).toEqual(
      allOf({ kind: 'controller', who: 'you' }, { kind: 'subtype', value: 'Sliver' }),
    );
  });

  it('still halts on a tribe that is in neither vocabulary', () => {
    // Not a creature type and not one of the card's own subtypes: a wrong guess here would
    // silently buff nothing, so the card stays unmodeled and the engine halts loudly.
    const def = interpretCard(
      oracle({
        name: 'Test Oddity',
        typeLine: 'Artifact',
        manaCost: '{2}',
        power: null,
        toughness: null,
        oracleText: 'Blorbs you control get +1/+1.',
      }),
    );
    expect(def.modeled).toBe(false);
    expect(def.unmodeledReasons).toEqual([
      'unrecognized rules text: "Blorbs you control get +1/+1."',
    ]);
  });

  it('leaves an anthem unmodeled when it grants a keyword the engine does not implement', () => {
    const def = interpretCard(
      oracle({
        name: 'Test Warlord',
        typeLine: 'Creature — Goblin Warrior',
        manaCost: '{2}{R}',
        power: '2',
        toughness: '2',
        oracleText: 'Other Goblins you control have mountainwalk.',
      }),
    );
    expect(def.modeled).toBe(false);
    expect(def.unmodeledReasons).toEqual([
      'unrecognized rules text: "Other Goblins you control have mountainwalk."',
    ]);
  });
});
