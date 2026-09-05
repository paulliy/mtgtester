/**
 * Library and mass primitives (ADR 0010, Inc 6): search, shuffle, scry, look-at-top-N, and
 * "damage to each `<selector>`".
 *
 * These are the first effects that touch hidden information and the first that consume
 * randomness, so what they must get right is narrower than "the card works":
 *
 * - a search never obliges the searcher to find (CR 701.19c), and never finds a card the
 *   filter excludes;
 * - "put it onto the battlefield tapped" is decisive over the card's own enters-tapped rules;
 * - every shuffle and every random ordering comes from `ctx.rng`, so the same seed replays
 *   identically (brief §4/§5.9) — the tests assert reproducibility, not a specific order;
 * - a keyword selector is read once, at resolution, against CURRENT keywords: a creature
 *   granted flying is spared by "each creature without flying".
 */

import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { computeCharacteristics } from '../src/effects/continuous';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import {
  conjure,
  copies,
  forest,
  gameConfig,
  island,
  keywordCreature,
  mountain,
  oracle,
  plains,
  pump,
  registerCustomDef,
  registerDef,
  spawn,
} from './fixtures';

function pod(seed = 'library'): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(2, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

const p1 = (ctx: GameContext): EnginePlayerState =>
  ctx.state.players.find((p) => p.id === 'P1') as EnginePlayerState;

const farseek = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Farseek',
    typeLine: 'Sorcery',
    manaCost: '{1}{G}',
    power: null,
    toughness: null,
    oracleText:
      'Search your library for a Plains, Island, Swamp, or Mountain card, put it onto the battlefield tapped, then shuffle.',
  });

const kodamasReach = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Reach',
    typeLine: 'Sorcery',
    manaCost: '{2}{G}',
    power: null,
    toughness: null,
    oracleText:
      'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.',
  });

const ryusei = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Ryusei',
    typeLine: 'Legendary Creature — Dragon Spirit',
    manaCost: '{5}{R}',
    power: '4',
    toughness: '4',
    oracleText: 'Flying\nWhen Test Ryusei dies, it deals 5 damage to each creature without flying.',
  });

const ureni = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Ureni of the Deep',
    typeLine: 'Legendary Creature — Spirit Dragon',
    manaCost: '{4}{G}{U}{R}',
    power: '8',
    toughness: '8',
    oracleText:
      'Flying, trample\nWhenever Test Ureni enters or attacks, look at the top eight cards of your library. You may put a Dragon creature card from among them onto the battlefield. Put the rest on the bottom of your library in a random order.',
  });

/** Run a card's spell ability directly, answering decisions with `answer`. */
function castSpell(
  ctx: GameContext,
  card: ReturnType<typeof oracle>,
  answer?: Parameters<typeof pump>[1],
): ReturnType<typeof pump> {
  const def = registerDef(ctx, card);
  const ability = def.spellAbility;
  if (ability === null) throw new Error(`${card.name} has no spell ability`);
  return pump(
    executeAbility(
      ctx,
      { cardId: 'c-source', name: card.name, oracleId: def.oracleId, controllerId: 'P1' },
      ability,
      [],
    ),
    answer,
  );
}

/** Pick the first option whose description matches. */
const choose =
  (pattern: RegExp) =>
  (d: Parameters<NonNullable<Parameters<typeof pump>[1]>>[0]): { index: number; targets: Map<number, string> } => {
    const i = d.options.findIndex((o) => pattern.test(o.description));
    return { index: i >= 0 ? i : 0, targets: new Map() };
  };

describe('library search', () => {
  it('offers only cards matching the filter, and puts the choice where the card says', () => {
    const ctx = pod();
    const player = p1(ctx);
    player.library.length = 0;
    conjure(ctx, 'P1', island(), 'library');
    conjure(ctx, 'P1', plains(), 'library'); // 2 distinct names -> decision surfaced
    conjure(ctx, 'P1', forest(), 'library'); // a Forest is NOT a Farseek target

    const { decisions } = castSpell(ctx, farseek(), choose(/Island/));

    const search = decisions.find((d) => d.prompt.includes('search your library'));
    expect(search?.options.map((o) => o.description)).toEqual([
      'Put Plains onto the battlefield tapped',
      'Put Island onto the battlefield tapped',
      'Find nothing',
    ]);
    const found = ctx.state.battlefield.find((p) => p.name === 'Island');
    expect(found?.tapped).toBe(true);
    expect(player.library.map((c) => c.name)).toEqual(['Plains', 'Forest']);
  });

  it('shuffles before putting a tutor target on top of the library', () => {
    const ctx = pod('top-tutor');
    const player = p1(ctx);
    player.library.length = 0;
    const topTutor = oracle({
      name: 'Top Tutor',
      typeLine: 'Instant',
      manaCost: '{U}',
      power: null,
      toughness: null,
      oracleText:
        'Search your library for an artifact card, reveal it, then shuffle and put that card on top.',
    });
    const relic = oracle({ name: 'Aether Relic', typeLine: 'Artifact' });
    const bauble = oracle({ name: 'Myr Bauble', typeLine: 'Artifact' });
    conjure(ctx, 'P1', forest(), 'library');
    conjure(ctx, 'P1', relic, 'library');
    conjure(ctx, 'P1', bauble, 'library');

    const { decisions } = castSpell(ctx, topTutor, choose(/Aether Relic/));

    expect(decisions.filter((d) => d.prompt.includes('search your library'))).toHaveLength(1);
    expect(player.library[0]?.name).toBe('Aether Relic');
    expect(player.library).toHaveLength(3);
    expect(player.library.some((card) => card.name === 'Myr Bauble')).toBe(true);
    expect(player.library.some((card) => card.name === 'Forest')).toBe(true);
  });
  it('executes the four top-library tutors and leaves the chosen card on top', () => {
    const cases = [
      {
        card: oracle({
          name: 'Enlightened Tutor',
          typeLine: 'Instant',
          manaCost: '{W}',
          power: null,
          toughness: null,
          oracleText:
            'Search your library for an artifact or enchantment card, reveal it, then shuffle and put that card on top.',
        }),
        target: oracle({ name: 'Tutor Artifact', typeLine: 'Artifact' }),
        other: oracle({ name: 'Tutor Enchantment', typeLine: 'Enchantment' }),
      },
      {
        card: oracle({
          name: 'Mystical Tutor',
          typeLine: 'Instant',
          manaCost: '{U}',
          power: null,
          toughness: null,
          oracleText:
            'Search your library for an instant or sorcery card, reveal it, then shuffle and put that card on top.',
        }),
        target: oracle({ name: 'Tutor Instant', typeLine: 'Instant' }),
        other: oracle({ name: 'Tutor Sorcery', typeLine: 'Sorcery' }),
      },
      {
        card: oracle({
          name: 'Worldly Tutor',
          typeLine: 'Instant',
          manaCost: '{G}',
          power: null,
          toughness: null,
          oracleText:
            'Search your library for a creature card, reveal it, then shuffle and put that card on top.',
        }),
        target: oracle({ name: 'Tutor Creature', typeLine: 'Creature' }),
        other: oracle({ name: 'Tutor Backup Creature', typeLine: 'Creature' }),
      },
      {
        card: oracle({
          name: 'Vampiric Tutor',
          typeLine: 'Instant',
          manaCost: '{B}',
          power: null,
          toughness: null,
          oracleText: 'Search your library for a card, then shuffle and put that card on top. You lose 2 life.',
        }),
        target: oracle({ name: 'Tutor Any Card' }),
        other: oracle({ name: 'Tutor Another Card' }),
      },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      const ctx = pod('top-tutor-' + index);
      const player = p1(ctx);
      player.library.length = 0;
      conjure(ctx, 'P1', forest(), 'library');
      conjure(ctx, 'P1', testCase.target, 'library');
      conjure(ctx, 'P1', testCase.other, 'library');

      const { decisions } = castSpell(
        ctx,
        testCase.card,
        choose(new RegExp(testCase.target.name)),
      );

      expect(decisions.filter((d) => d.prompt.includes('search your library'))).toHaveLength(1);
      expect(player.library[0]?.name).toBe(testCase.target.name);
      expect(player.library).toHaveLength(3);
    }
  });
  it('auto-selects when all matching cards in library share the same name', () => {
    const ctx = pod();
    const player = p1(ctx);
    player.library.length = 0;
    conjure(ctx, 'P1', island(), 'library');
    conjure(ctx, 'P1', island(), 'library');
    conjure(ctx, 'P1', forest(), 'library');

    const { decisions } = castSpell(ctx, farseek());

    // Single distinct matching land name auto-selects without surfacing an AI decision
    expect(decisions.some((d) => d.prompt.includes('search your library'))).toBe(false);
    const found = ctx.state.battlefield.find((p) => p.name === 'Island');
    expect(found?.tapped).toBe(true);
    expect(player.library.map((c) => c.name)).toEqual(['Island', 'Forest']);
  });

  it('never obliges the searcher to find one (CR 701.19c)', () => {
    const ctx = pod();
    p1(ctx).library.length = 0;
    conjure(ctx, 'P1', island(), 'library');
    conjure(ctx, 'P1', plains(), 'library');

    castSpell(ctx, farseek(), choose(/Find nothing/));

    expect(ctx.state.battlefield.some((p) => p.name === 'Island')).toBe(false);
    expect(ctx.state.battlefield.some((p) => p.name === 'Plains')).toBe(false);
    expect(p1(ctx).library).toHaveLength(2);
  });

  it('surfaces no decision at all when nothing in the library matches', () => {
    const ctx = pod();
    p1(ctx).library.length = 0;
    conjure(ctx, 'P1', forest(), 'library');

    const { decisions } = castSpell(ctx, farseek());

    expect(decisions.some((d) => d.prompt.includes('search your library'))).toBe(false);
  });

  it('asks once per destination, in printed order (Kodama’s Reach)', () => {
    const ctx = pod();
    p1(ctx).library.length = 0;
    conjure(ctx, 'P1', mountain(), 'library');
    conjure(ctx, 'P1', island(), 'library');
    conjure(ctx, 'P1', plains(), 'library');

    const { decisions } = castSpell(ctx, kodamasReach(), (d) => {
      if (d.prompt.includes('onto the battlefield tapped')) return choose(/Mountain/)(d);
      if (d.prompt.includes('into your hand')) return choose(/Island/)(d);
      return { index: 0, targets: new Map() };
    });

    expect(decisions.filter((d) => d.prompt.includes('search your library'))).toHaveLength(2);
    expect(ctx.state.battlefield.find((p) => p.name === 'Mountain')?.tapped).toBe(true);
    expect(p1(ctx).hand.map((c) => c.name)).toContain('Island');
  });

  it('stops early when fewer cards match than there are destinations', () => {
    const ctx = pod();
    p1(ctx).library.length = 0;
    conjure(ctx, 'P1', mountain(), 'library');

    castSpell(ctx, kodamasReach(), choose(/Mountain/));

    expect(ctx.state.battlefield.some((p) => p.name === 'Mountain')).toBe(true);
    expect(p1(ctx).hand).toHaveLength(0);
  });

  it('shuffles with the seeded PRNG, so the same seed gives the same library', () => {
    const run = (): string[] => {
      const ctx = pod('shuffle-seed');
      const player = p1(ctx);
      player.library.length = 0;
      for (let i = 0; i < 12; i++) {
        conjure(ctx, 'P1', oracle({ name: `Card ${i}`, typeLine: 'Creature — Test' }), 'library');
      }
      conjure(ctx, 'P1', island(), 'library');
      castSpell(ctx, farseek(), choose(/Island/));
      return player.library.map((c) => c.name);
    };

    const first = run();
    expect(run()).toEqual(first);
    // …and it really did shuffle, rather than leaving insertion order alone.
    expect(first).not.toEqual([...first].sort());
  });
});

describe('scry', () => {
  it('keeps a card on top or sends it to the bottom, as chosen', () => {
    const build = (): { ctx: GameContext; def: ReturnType<typeof interpretCard> } => {
      const ctx = pod();
      p1(ctx).library.length = 0;
      conjure(ctx, 'P1', mountain(), 'library');
      conjure(ctx, 'P1', island(), 'library'); // unshift → Island is on top
      const def = interpretCard(
        oracle({
          name: 'Test Temple',
          typeLine: 'Land',
          manaCost: null,
          power: null,
          toughness: null,
          oracleText: 'This land enters tapped.\nWhen this land enters, scry 1.',
        }),
      );
      return { ctx, def };
    };

    for (const [pattern, expected] of [
      [/Keep/, ['Island', 'Mountain']],
      [/bottom/, ['Mountain', 'Island']],
    ] as const) {
      const { ctx, def } = build();
      pump(
        executeAbility(
          ctx,
          { cardId: 'c-temple', name: def.name, oracleId: def.oracleId, controllerId: 'P1' },
          def.triggers[0] as never,
          [],
        ),
        choose(pattern),
      );
      expect(p1(ctx).library.map((c) => c.name)).toEqual(expected);
    }
  });

  it('can reorder multiple cards kept on top', () => {
    const ctx = pod();
    p1(ctx).library.length = 0;
    conjure(ctx, 'P1', mountain(), 'library');
    conjure(ctx, 'P1', island(), 'library');
    const ability = interpretCard(
      oracle({
        name: 'Test Scry Two',
        typeLine: 'Sorcery',
        manaCost: '{U}',
        power: null,
        toughness: null,
        oracleText: 'Scry 2.',
      }),
    ).spellAbility!;
    pump(
      executeAbility(
        ctx,
        { cardId: 'c-scry-two', name: 'Test Scry Two', oracleId: 'oracle-test-scry-two', controllerId: 'P1' },
        ability,
        [],
      ),
      (decision) => {
        if (decision.prompt.includes('reorder the cards')) return { index: 1, targets: new Map() };
        if (decision.prompt.includes('choose the next card')) {
          return { index: decision.options.findIndex((option) => option.description.includes('Mountain')), targets: new Map() };
        }
        return { index: 0, targets: new Map() };
      },
    );
    expect(p1(ctx).library.map((card) => card.name)).toEqual(['Mountain', 'Island']);
  });
});

describe('draw, discard, mill, and surveil', () => {
  it('parses variable draw and mill, then resolves a chosen discard and surveil', () => {
    const drawDiscard = interpretCard(
      oracle({
        name: 'Test Pull',
        typeLine: 'Instant',
        manaCost: '{X}{U}',
        power: null,
        toughness: null,
        oracleText: 'Draw X cards, then discard a card.',
      }),
    );
    const mill = interpretCard(
      oracle({
        name: 'Test Mill',
        typeLine: 'Sorcery',
        manaCost: '{U}',
        power: null,
        toughness: null,
        oracleText: 'Mill two cards.',
      }),
    );
    const surveil = interpretCard(
      oracle({
        name: 'Test Surveil',
        typeLine: 'Sorcery',
        manaCost: '{U}',
        power: null,
        toughness: null,
        oracleText: 'Surveil 1.',
      }),
    );
    expect(drawDiscard.spellAbility?.effects).toEqual([
      { op: 'draw', count: { kind: 'xValue' } },
      { op: 'discard', count: 1 },
    ]);
    expect(mill.spellAbility?.effects).toEqual([{ op: 'mill', count: { kind: 'const', n: 2 } }]);

    const ctx = pod();
    p1(ctx).library.length = 0;
    conjure(ctx, 'P1', mountain(), 'library');
    conjure(ctx, 'P1', island(), 'library');
    conjure(ctx, 'P1', forest(), 'hand');
    pump(
      executeAbility(
        ctx,
        { cardId: 'c-pull', name: drawDiscard.name, oracleId: drawDiscard.oracleId, controllerId: 'P1' },
        drawDiscard.spellAbility as never,
        [],
        undefined,
        { x: 1 },
      ),
      choose(/Forest/),
    );
    expect(p1(ctx).graveyard.map((card) => card.name)).toContain('Forest');

    pump(
      executeAbility(
        ctx,
        { cardId: 'c-surveil', name: surveil.name, oracleId: surveil.oracleId, controllerId: 'P1' },
        surveil.spellAbility as never,
        [],
      ),
      choose(/graveyard/),
    );
    expect(p1(ctx).graveyard.map((card) => card.name)).toContain('Mountain');
  });
});

describe('mass damage and event-only keyword selectors', () => {
  it('hits creatures without flying and spares the ones with it', () => {
    const ctx = pod();
    const ground = spawn(ctx, 'P1', keywordCreature('Test Ground', '', '{1}{W}', '2/6'));
    const flier = spawn(ctx, 'P2', keywordCreature('Test Flier', 'Flying', '{1}{U}', '2/6'));
    const def = registerDef(ctx, ryusei());

    pump(
      executeAbility(
        ctx,
        { cardId: 'c-ryusei', name: def.name, oracleId: def.oracleId, controllerId: 'P1' },
        def.triggers[0] as never,
        [],
      ),
    );

    expect(ground.damageMarked).toBe(5);
    expect(flier.damageMarked).toBe(0);
  });

  it('reads CURRENT keywords, so a granted flier is spared', () => {
    const ctx = pod();
    const ground = spawn(ctx, 'P1', keywordCreature('Test Ground', '', '{1}{W}', '2/6'));
    // An until-end-of-turn grant, exactly as Inc 4's `grantKeywordUntilEot` records one.
    ctx.state.effects.push({
      id: 'eff-grant',
      sourceId: 'c-other',
      description: 'Test Ground gains flying until end of turn',
      targetCardIds: [ground.cardId],
      kind: 'grantKeyword',
      keyword: 'flying',
      timestamp: ctx.state.nextTimestamp++,
    });
    const def = registerDef(ctx, ryusei());

    pump(
      executeAbility(
        ctx,
        { cardId: 'c-ryusei', name: def.name, oracleId: def.oracleId, controllerId: 'P1' },
        def.triggers[0] as never,
        [],
      ),
    );

    expect(ground.damageMarked).toBe(0);
  });

  it('refuses to let a keyword selector be a static ability’s affected set', () => {
    const ctx = pod();
    const card = oracle({
      name: 'Test Bad Anthem',
      typeLine: 'Enchantment',
      power: null,
      toughness: null,
    });
    const perm = spawn(ctx, 'P1', card);
    // "Creatures with flying get +1/+1" would let one layer-6 grant change a layer-7d effect's
    // affected set, which is precisely what the event-only ban exists to prevent. The text
    // grammar cannot produce this — the guard catches a modeling mistake, not a card.
    registerCustomDef(ctx, {
      ...interpretCard(card),
      staticEffects: [
        {
          affects: { kind: 'hasKeyword', keyword: 'flying' },
          op: { layer: 7, sublayer: 'd', power: 1, toughness: 1 },
        },
      ],
    });

    expect(() => computeCharacteristics(ctx, perm)).toThrow(/keywords/);
  });
});

describe('look at the top N', () => {
  it('takes an eligible card and bottoms the rest, reproducibly', () => {
    const play = (): { taken: boolean; library: string[] } => {
      const ctx = pod('ureni-seed');
      const player = p1(ctx);
      player.library.length = 0;
      for (let i = 0; i < 7; i++) {
        conjure(ctx, 'P1', oracle({ name: `Filler ${i}`, typeLine: 'Creature — Bear' }), 'library');
      }
      conjure(
        ctx,
        'P1',
        oracle({ name: 'Test Whelp', typeLine: 'Creature — Dragon', manaCost: '{4}{R}' }),
        'library',
      );
      const def = registerDef(ctx, ureni());
      pump(
        executeAbility(
          ctx,
          { cardId: 'c-ureni', name: def.name, oracleId: def.oracleId, controllerId: 'P1' },
          def.triggers[0] as never,
          [],
        ),
        choose(/Put Test Whelp/),
      );
      return {
        taken: ctx.state.battlefield.some((p) => p.name === 'Test Whelp'),
        library: player.library.map((c) => c.name),
      };
    };

    const first = play();
    expect(first.taken).toBe(true);
    expect(first.library).toHaveLength(7);
    // Same seed, same random bottom order (brief §5.9).
    expect(play()).toEqual(first);
  });

  it('offers only eligible cards, and declining leaves the library intact in size', () => {
    const ctx = pod();
    const player = p1(ctx);
    player.library.length = 0;
    for (let i = 0; i < 3; i++) {
      conjure(ctx, 'P1', oracle({ name: `Filler ${i}`, typeLine: 'Creature — Bear' }), 'library');
    }
    const def = registerDef(ctx, ureni());

    const { decisions } = pump(
      executeAbility(
        ctx,
        { cardId: 'c-ureni', name: def.name, oracleId: def.oracleId, controllerId: 'P1' },
        def.triggers[0] as never,
        [],
      ),
    );

    // No Dragon among them: nothing to offer, so no decision is surfaced at all.
    expect(decisions).toHaveLength(0);
    expect(player.library).toHaveLength(3);
  });

  it('produces two separate triggers from "enters or attacks"', () => {
    const def = interpretCard(ureni());

    expect(def.modeled).toBe(true);
    expect(def.triggers.map((t) => t.trigger?.when)).toEqual(['enters', 'attacks']);
  });
});
