/**
 * The card compiler's free meaning check (`scripts/card-compiler/render.ts`) settles a compiled
 * patch with no model call when the patch renders back to its Oracle lines. These tests keep the
 * gain it makes (`compiler.textCheckSettledPatches` in the hill-climb baseline) from costing
 * correctness:
 *
 * - every settled trial patch has a hand audit entry saying it is correct, and no patch an audit
 *   found wrong settles;
 * - no single-step change to a settled patch or a matching pool card that still validates and
 *   means something else settles (`settle-mutants.ts`);
 * - the wordings the check treats as equal are pinned one by one below.
 *
 * A renderer change that settles a new patch fails the first test until someone audits the patch
 * by hand and adds it to `scripts/card-compiler/settle-audit.json`.
 */
import { describe, expect, it } from 'vitest';
import type { CardDefinition } from '../../../engine/src/cards/definition';
import {
  alt,
  expandAlternatives,
  normalizeLine,
  textCheck,
} from '../../../../scripts/card-compiler/render';
import { auditList, measureSettle, trialPatches } from '../../../../scripts/card-compiler/settle';
import {
  canonicalDefinition,
  patchMutants,
  poolCases,
  mutationVocabulary,
  survivingMutants,
  trialCases,
} from '../../../../scripts/card-compiler/settle-mutants';

const patches = trialPatches();

describe('free text check on the committed trial patches', () => {
  it('settles only patches a hand audit found correct', () => {
    const audit = new Map(auditList().map((entry) => [entry.name, entry]));
    const settled = measureSettle(patches).settled;
    const unaudited = settled.filter((name) => audit.get(name)?.verdict !== 'correct');
    expect(unaudited, 'audit these by hand, then add them to settle-audit.json').toEqual([]);
    const wrong = [...audit.values()].filter((entry) => entry.verdict === 'wrong');
    expect(wrong.map((entry) => entry.name).sort()).toEqual([
      'Charmbreaker Devils',
      'Thran Turbine',
    ]);
    for (const entry of wrong) expect(settled).not.toContain(entry.name);
  });

  it('keeps every audit entry pointing at a committed patch', () => {
    const names = new Set(patches.map((patch) => patch.name));
    for (const entry of auditList()) expect(names.has(entry.name), entry.name).toBe(true);
  });
});

describe('free text check soundness: no changed patch settles', () => {
  const pool = poolCases();
  const vocabulary = mutationVocabulary([
    ...patches.map((patch) => patch.def),
    ...pool.map((item) => item.def),
  ]);

  it('fails every meaning-changing mutant of a settled trial patch', () => {
    expect(survivingMutants(trialCases(patches), vocabulary)).toEqual([]);
  }, 120_000);

  it('tries restrictions a node could hold but does not, such as a sacrifice that allows itself', () => {
    const acolyte = patches.find((patch) => patch.name === 'Acolyte of Aclazotz')!;
    const labels = patchMutants(acolyte.def, vocabulary).map((mutant) => mutant.label);
    expect(labels).toContain('.activatedAbilities[0].costs[1].allowSelf: add true');
    expect(labels).toContain('.activatedAbilities[0].timing: "any" -> "sorcery"');
  });

  it('fails every meaning-changing mutant of a pool card it matches', () => {
    expect(survivingMutants(pool, vocabulary)).toEqual([]);
  }, 300_000);
});

const card = (name: string, oracleText: string) => ({ name, oracleText });
const check = (
  def: Partial<CardDefinition>,
  { name, oracleText }: { name: string; oracleText: string },
  lines = oracleText.split('\n'),
) => textCheck(def, lines, name, oracleText).verdict;

const tap = { kind: 'tap' } as const;
const activated = (
  effects: unknown[],
  extra: Record<string, unknown> = {},
  costs: unknown[] = [tap],
) =>
  ({
    activatedAbilities: [
      { costs, timing: 'any', ability: { kind: 'activated', targets: [], effects }, ...extra },
    ],
  }) as unknown as Partial<CardDefinition>;
const elves = {
  kind: 'countPermanents',
  selector: { kind: 'subtype', value: 'Elf' },
  scope: 'all',
};

describe('free text check wordings', () => {
  it('expands alternative groups, innermost first', () => {
    expect(expandAlternatives(`a ${alt('b', 'c')} d`)).toEqual(['a b d', 'a c d']);
    expect(expandAlternatives(alt('x', `y ${alt('1', '2')}`))).toEqual(['x', 'y 1', 'y 2']);
    expect(alt('same', 'same')).toBe('same');
  });

  it('accepts each Oracle wording of a counted amount', () => {
    const def = activated([{ op: 'gainLife', amount: elves }]);
    for (const text of [
      '{T}: You gain 1 life for each Elf on the battlefield.',
      '{T}: You gain X life, where X is the number of Elves on the battlefield.',
      '{T}: You gain life equal to the number of Elves on the battlefield.',
    ])
      expect(check(def, card('Wellwisher', text)), text).toBe('match');
    expect(
      check(def, card('Wellwisher', '{T}: You gain 2 life for each Elf on the battlefield.')),
    ).toBe('mismatch');
  });

  it('lets one rendered line use up only one printed line', () => {
    const def = activated([{ op: 'gainLife', amount: elves }]);
    const oracle = card(
      'Twice',
      '{T}: You gain 1 life for each Elf on the battlefield.\n{T}: You gain X life, where X is the number of Elves on the battlefield.',
    );
    expect(check(def, oracle)).toBe('mismatch');
  });

  it('needs one rendered ability for each of two identical printed lines', () => {
    const forest = {
      affects: { kind: 'self' },
      op: { layer: 7, sublayer: 'd', power: 1, toughness: 1 },
      condition: {
        kind: 'countPermanents',
        selector: { kind: 'subtype', value: 'Forest' },
        scope: 'you',
        cmp: '>=',
        n: 1,
      },
    };
    const line = 'As long as you control a Forest, Twin gets +1/+1.';
    const twice = card('Twin', `${line}\n${line}`);
    const one = { staticEffects: [forest] } as unknown as Partial<CardDefinition>;
    const two = { staticEffects: [forest, { ...forest }] } as unknown as Partial<CardDefinition>;
    expect(check(one, card('Twin', line))).toBe('match');
    expect(check(one, twice)).toBe('mismatch');
    // Two identical statics in a row would also render as one grouped line, so check that the
    // pair is at least not accepted for a single printed line.
    expect(check(two, card('Twin', line))).not.toBe('match');
  });

  it('ignores mana symbol order, ability words before triggers, and "he" or "she"', () => {
    const name = 'Smaug';
    expect(normalizeLine('{G}{U}, {T}: Draw a card.', name)).toBe(
      normalizeLine('{U}{G}, {T}: Draw a card.', name),
    );
    expect(normalizeLine('Magecraft — Whenever you cast a spell, draw a card.', name)).toBe(
      normalizeLine('Whenever you cast a spell, draw a card.', name),
    );
    expect(normalizeLine('Whenever Smaug attacks, he deals 1 damage to any target.', name)).toBe(
      normalizeLine('Whenever Smaug attacks, Smaug deals 1 damage to any target.', name),
    );
    // A keyword before a cost restricts the ability, so it is kept.
    expect(normalizeLine('Boast — {1}{R}: Draw a card.', name)).not.toBe(
      normalizeLine('{1}{R}: Draw a card.', name),
    );
  });

  it('prints a token name that is not its subtypes, and names predefined tokens only', () => {
    const coil = {
      name: "Koma's Coil",
      typeLine: 'Token Creature — Serpent',
      types: ['Creature'],
      subtypes: ['Serpent'],
      colors: ['U'],
      power: 3,
      toughness: 3,
    };
    const create = (spec: unknown) =>
      ({
        spellAbility: {
          kind: 'spell',
          targets: [],
          effects: [{ op: 'createToken', spec, count: 1 }],
        },
      }) as unknown as Partial<CardDefinition>;
    const koma = card('Koma', "Create a 3/3 blue Serpent creature token named Koma's Coil.");
    expect(check(create(coil), koma)).toBe('match');
    expect(check(create({ ...coil, name: 'Serpent' }), koma)).toBe('mismatch');
    expect(check(create({ ...coil, typeLine: 'Creature — Dragon' }), koma)).toBe('unrendered');
    const treasure = {
      name: 'Treasure',
      typeLine: 'Artifact — Treasure',
      types: ['Artifact'],
      subtypes: ['Treasure'],
      colors: [],
      power: null,
      toughness: null,
      manaAbilities: [
        { units: [['W', 'U', 'B', 'R', 'G']], costs: [{ kind: 'tap' }, { kind: 'sacrificeSelf' }] },
      ],
    };
    expect(check(create(treasure), card('Loot', 'Create a Treasure token.'))).toBe('match');
    expect(
      check(create({ ...treasure, manaAbilities: [] }), card('Loot', 'Create a Treasure token.')),
    ).not.toBe('match');
  });

  it('says "another" for a sacrifice that excludes the source, and "a" only with allowSelf', () => {
    const sacrifice = (extra: Record<string, unknown>) =>
      activated([{ op: 'draw', count: 1 }], {}, [
        {
          kind: 'sacrificeOther',
          selector: {
            kind: 'allOf',
            of: [
              { kind: 'controller', who: 'you' },
              { kind: 'type', value: 'Creature' },
            ],
          },
          ...extra,
        },
      ]);
    const another = card('Altar', 'Sacrifice another creature: Draw a card.');
    const any = card('Altar', 'Sacrifice a creature: Draw a card.');
    expect(check(sacrifice({}), another)).toBe('match');
    expect(check(sacrifice({}), any)).toBe('mismatch');
    expect(check(sacrifice({ allowSelf: true }), any)).toBe('match');
  });

  it('reads an ability of a card in the graveyard only when its text says so', () => {
    const exile = { kind: 'exileSelfFromGraveyard' };
    const oracle = card('Wurm', '{T}, Exile this card from your graveyard: Draw a card.');
    const draw = [{ op: 'draw', count: 1 }];
    expect(check(activated(draw, { zone: 'graveyard' }, [tap, exile]), oracle)).toBe('match');
    expect(check(activated(draw, {}, [tap, exile]), oracle)).toBe('unrendered');
    expect(check(activated(draw, { zone: 'graveyard' }), card('Wurm', '{T}: Draw a card.'))).toBe(
      'unrendered',
    );
  });

  it('writes "it" for a repeated target only when the ability has one target', () => {
    const def = {
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'creature' }, { kind: 'creature' }],
        effects: [
          { op: 'tapTarget', target: 0 },
          { op: 'untapTarget', target: 1 },
          { op: 'grantKeywordUntilEot', target: 0, keyword: 'flying' },
        ],
      },
    } as unknown as Partial<CardDefinition>;
    expect(
      check(
        def,
        card(
          'Two',
          'Tap target creature. Untap target creature. It gains flying until end of turn.',
        ),
      ),
    ).toBe('unrendered');
  });

  it('never settles entersTapped: false, which would clear a printed "enters tapped"', () => {
    const goblinTown = patches.find((patch) => patch.name === 'Goblin-town')!;
    const check = (def: Partial<CardDefinition>) =>
      textCheck(def, goblinTown.handledLines, goblinTown.name, goblinTown.oracleText).verdict;
    expect(check(goblinTown.def)).toBe('match');
    expect(check({ ...goblinTown.def, entersTapped: false })).toBe('unrendered');
    expect(
      patchMutants(
        goblinTown.def,
        mutationVocabulary([goblinTown.def, { entersTapped: true }]),
      ).map((mutant) => mutant.label),
    ).toContain('.entersTapped: add false');
  });

  it('treats an ability-order or default-only change as the same card', () => {
    expect(canonicalDefinition({ keywords: ['flying', 'haste'] })).toBe(
      canonicalDefinition({ keywords: ['haste', 'flying'] }),
    );
    expect(canonicalDefinition({ optional: false, targets: [], timing: 'any' })).toBe(
      canonicalDefinition({}),
    );
    expect(canonicalDefinition({ timing: 'sorcery' })).not.toBe(canonicalDefinition({}));
  });
});
