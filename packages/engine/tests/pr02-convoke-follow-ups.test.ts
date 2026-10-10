import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import { addMana } from '../src/mana/pool';
import { copies, conjure, forest, gameConfig, oracle, plains, pump, spawn } from './fixtures';

type CastPayload = Extract<PriorityActionPayload, { kind: 'castSpell' }>;

const pinned = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/marchesa-batch1-oracle.json'), 'utf8'),
) as { cards: { sha256: string; card: ReturnType<typeof oracle> }[] };

function card(name: string) {
  const entry = pinned.cards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`missing pinned card ${name}`);
  return entry;
}

function game(seed = 'pr02-convoke') {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

function castOptions(ctx: ReturnType<typeof game>, objectId: string) {
  return computePriorityOptions(ctx, playerById(ctx, 'P1')).filter((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === objectId;
  });
}

function cast(ctx: ReturnType<typeof game>, option: { payload?: unknown }) {
  return pump(
    applyPriorityAction(ctx, playerById(ctx, 'P1'), option.payload as CastPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
}

function adventure(name: string, frontText: string, backText: string) {
  return oracle({
    name,
    typeLine: 'Creature — Test // Instant — Adventure',
    types: ['Creature'],
    subtypes: ['Test'],
    manaCost: '{3}{W} // {1}{W}',
    cmc: 4,
    oracleText: frontText,
    layout: 'adventure',
    backFace: {
      name: 'Convoke Venture',
      typeLine: 'Instant — Adventure',
      oracleText: backText,
      manaCost: '{1}{W}',
      colors: ['W'],
      power: null,
      toughness: null,
    },
  });
}

describe('PR02 convoke payment follow-ups', () => {
  it('uses the selected Adventure face: parent convoke cannot pay for a nonconvoke Adventure', () => {
    const ctx = game();
    const parentConvoke = adventure('Parent Convoke Probe', 'Convoke', 'You gain 1 life.');
    const obj = conjure(ctx, 'P1', parentConvoke, 'hand');
    const creatures = [
      spawn(ctx, 'P1', oracle({ name: 'White creature', colors: ['W'] })),
      spawn(ctx, 'P1', oracle({ name: 'Generic creature' })),
    ];

    expect(
      castOptions(ctx, obj.id).some((entry) => entry.data?.['castVariant'] === 'adventure'),
    ).toBe(false);
    expect(creatures.every((permanent) => !permanent.tapped)).toBe(true);
  });

  it('offers the Convoke Adventure face when the parent face has no convoke', () => {
    const ctx = game();
    const parent = adventure('Adventure Convoke Probe', '', 'Convoke\nYou gain 1 life.');
    const obj = conjure(ctx, 'P1', parent, 'hand');
    const white = spawn(ctx, 'P1', oracle({ name: 'White creature', colors: ['W'] }));
    const generic = spawn(ctx, 'P1', oracle({ name: 'Generic creature' }));
    const option = castOptions(ctx, obj.id).find(
      (entry) => entry.data?.['castVariant'] === 'adventure',
    );

    expect(option).toBeDefined();
    cast(ctx, option!);
    expect([white.tapped, generic.tapped]).toEqual([true, true]);
    expect(ctx.state.stack[0]?.description).toContain('Convoke Venture');
  });

  it('uses Conclave Tribunal through the normal cast path and consumes one creature per symbol', () => {
    const ctx = game();
    const tribunal = card('Conclave Tribunal');
    expect(tribunal.sha256).toMatch(/^[a-f0-9]{64}$/);
    const obj = conjure(ctx, 'P1', tribunal.card, 'hand');
    spawn(ctx, 'P2', oracle({ name: 'Tribunal Target', typeLine: 'Artifact', manaCost: '{0}' }));
    const white = spawn(ctx, 'P1', oracle({ name: 'White Soldier', colors: ['W'] }));
    const colorless = spawn(ctx, 'P1', oracle({ name: 'Colorless Golem' }));
    const otherWhite = spawn(ctx, 'P1', oracle({ name: 'Second White Soldier', colors: ['W'] }));
    const generic = spawn(ctx, 'P1', oracle({ name: 'Third Generic Creature' }));
    const option = castOptions(ctx, obj.id)[0];

    expect(option).toBeDefined();
    cast(ctx, option!);
    expect([white.tapped, colorless.tapped, otherWhite.tapped, generic.tapped]).toEqual([
      true,
      true,
      true,
      true,
    ]);
    // The four convoked creatures cover all four symbols, so none of the cost is mana spent.
    expect(ctx.state.stack[0]?.triggerScope?.manaSpent).toBe(0);
  });

  it('lets a colorless convoker pay generic but never a {C} pip', () => {
    const ctx = game();
    const colorless = spawn(ctx, 'P1', oracle({ name: 'Colorless Convoker' }));
    const needsC = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Needs True Colorless',
        typeLine: 'Sorcery',
        manaCost: '{C}',
        oracleText: 'You gain 1 life.',
      }),
      'hand',
    );
    // The spell must itself have convoke to permit a convoker payment.
    ctx.defs.set(needsC.oracleId, {
      ...ctx.defs.get(needsC.oracleId)!,
      ruleStatics: [{ kind: 'convoke' }],
    });
    expect(castOptions(ctx, needsC.id)).toHaveLength(0);
    expect(colorless.tapped).toBe(false);

    addMana(playerById(ctx, 'P1'), [{ symbol: 'C' }]);
    const option = castOptions(ctx, needsC.id)[0];
    expect(option).toBeDefined();
    cast(ctx, option!);
    expect(colorless.tapped).toBe(false);
  });

  it('matches colored convoke to a colored pip and uses a second creature for generic', () => {
    const ctx = game();
    const obj = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Convoke Colored Spell',
        typeLine: 'Sorcery',
        manaCost: '{1}{W}',
        oracleText: 'You gain 1 life.',
      }),
      'hand',
    );
    ctx.defs.set(obj.oracleId, {
      ...ctx.defs.get(obj.oracleId)!,
      ruleStatics: [{ kind: 'convoke' }],
    });
    const white = spawn(ctx, 'P1', oracle({ name: 'White Convoker', colors: ['W'] }));
    const colorless = spawn(ctx, 'P1', oracle({ name: 'Generic Convoker' }));
    const option = castOptions(ctx, obj.id)[0];

    expect(option).toBeDefined();
    cast(ctx, option!);
    expect([white.tapped, colorless.tapped]).toEqual([true, true]);
  });

  it('never uses one creature twice, including a creature that also produces mana', () => {
    const ctx = game();
    const obj = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Double Tap Probe',
        typeLine: 'Sorcery',
        manaCost: '{2}',
        oracleText: 'You gain 1 life.',
      }),
      'hand',
    );
    ctx.defs.set(obj.oracleId, {
      ...ctx.defs.get(obj.oracleId)!,
      ruleStatics: [{ kind: 'convoke' }],
    });
    const dualRole = spawn(
      ctx,
      'P1',
      oracle({ name: 'Mana Convoker', colors: ['G'], oracleText: '{T}: Add {G}.' }),
    );
    expect(castOptions(ctx, obj.id)).toHaveLength(0);
    expect(dualRole.tapped).toBe(false);
  });

  it('keeps convokers in the stateful payment search and chooses the same payer deterministically', () => {
    const payment = () => {
      const ctx = game('convoke-stateful-determinism');
      const obj = conjure(
        ctx,
        'P1',
        oracle({
          name: 'Stateful Convoke Spell',
          typeLine: 'Sorcery',
          manaCost: '{1}{W}',
          oracleText: 'You gain 1 life.',
        }),
        'hand',
      );
      ctx.defs.set(obj.oracleId, {
        ...ctx.defs.get(obj.oracleId)!,
        ruleStatics: [{ kind: 'convoke' }],
      });
      const white = spawn(ctx, 'P1', oracle({ name: 'Stateful White Convoker', colors: ['W'] }));
      const artifactCard = oracle({
        name: 'Stateful Rock',
        typeLine: 'Artifact',
        manaCost: '{0}',
        oracleText: '{T}: Add {C}.',
      });
      const rock = spawn(ctx, 'P1', artifactCard);
      const rockDef = ctx.defs.get(rock.oracleId)!;
      ctx.defs.set(rock.oracleId, {
        ...rockDef,
        manaAbilities: [{ units: [['C']], amount: { kind: 'const', n: 1 } }],
      });
      const option = castOptions(ctx, obj.id)[0];
      expect(option).toBeDefined();
      cast(ctx, option!);
      return [white.tapped, rock.tapped];
    };

    expect(payment()).toEqual([true, true]);
    expect(payment()).toEqual([true, true]);
  });

  it('includes convoke creatures in fixed-capacity pruning beside an invariant mana source rider', () => {
    const ctx = game('convoke-fixed-capacity-rider');
    const obj = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Fixed Capacity Convoke Spell',
        typeLine: 'Sorcery',
        manaCost: '{1}{W}',
        oracleText: 'You gain 1 life.',
      }),
      'hand',
    );
    ctx.defs.set(obj.oracleId, {
      ...ctx.defs.get(obj.oracleId)!,
      ruleStatics: [{ kind: 'convoke' }],
    });
    const white = spawn(
      ctx,
      'P1',
      oracle({ name: 'Fixed Capacity White Convoker', colors: ['W'] }),
    );
    const rockCard = oracle({
      name: 'Fixed Capacity Mana Rock',
      typeLine: 'Artifact',
      manaCost: '{0}',
      oracleText: '{T}: Add {C}.',
    });
    const rock = spawn(ctx, 'P1', rockCard);
    ctx.defs.set(rock.oracleId, {
      ...ctx.defs.get(rock.oracleId)!,
      manaAbilities: [
        {
          units: [['C']],
          onActivate: [{ op: 'gainLife', amount: { kind: 'const', n: 1 } }],
        },
      ],
    });
    const life = playerById(ctx, 'P1').life;
    const option = castOptions(ctx, obj.id)[0];

    expect(option).toBeDefined();
    cast(ctx, option!);
    expect(white.tapped).toBe(true);
    expect(rock.tapped).toBe(true);
    expect(playerById(ctx, 'P1').life).toBe(life + 1);
    expect(ctx.state.stack).toHaveLength(1);
  });

  it('does not convoke a creature that Szeras must sacrifice to produce payment mana', () => {
    const ctx = game('convoke-szeras-sacrifice-conflict');
    const tribunal = conjure(ctx, 'P1', card('Conclave Tribunal').card, 'hand');
    spawn(ctx, 'P1', card('Illuminor Szeras').card);
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Only Szeras Fodder Ox',
        typeLine: 'Creature — Ox',
        manaCost: '{2}',
        cmc: 2,
      }),
    );
    spawn(ctx, 'P1', plains());

    // Szeras can make {B}{B} by sacrificing the sole creature and the Plains makes {W}.
    // The Ox cannot also be counted as a convoker after it is sacrificed during payment.
    expect(castOptions(ctx, tribunal.id)).toHaveLength(0);
  });

  it('Hour of Reckoning remains castable with its pinned convoke rules text', () => {
    const ctx = game();
    const hour = card('Hour of Reckoning');
    expect(hour.sha256).toMatch(/^[a-f0-9]{64}$/);
    const obj = conjure(ctx, 'P1', hour.card, 'hand');
    const white = Array.from({ length: 3 }, (_, i) =>
      spawn(ctx, 'P1', oracle({ name: `Hour White Creature ${i}`, colors: ['W'] })),
    );
    const fourGeneric = Array.from({ length: 4 }, (_, i) =>
      spawn(ctx, 'P1', oracle({ name: `Hour Generic ${i}` })),
    );
    const option = castOptions(ctx, obj.id)[0];
    expect(option).toBeDefined();
    cast(ctx, option!);
    expect(white.every((permanent) => permanent.tapped)).toBe(true);
    expect(fourGeneric.every((permanent) => permanent.tapped)).toBe(true);
  });
});
