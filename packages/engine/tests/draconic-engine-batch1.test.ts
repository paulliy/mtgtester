import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import {
  computePriorityOptions,
  computeTargetOptions,
  type PriorityActionPayload,
} from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId, getOverride } from '../src/cards/overrides';
import { computeCharacteristics } from '../src/effects/continuous';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { moveObject, queueTriggersForEvent } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import {
  bear,
  conjure,
  copies,
  forest,
  gameConfig,
  keywordCreature,
  mountain,
  oracle,
  pick,
  pump,
  spawn,
} from './fixtures';

interface PinnedFixture {
  schemaVersion: number;
  source: string;
  retrievedAt: string;
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/draconic-engine-batch1-oracle.json'), 'utf8'),
) as PinnedFixture;

function canonical(value: unknown): string {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    }
    return input;
  };
  return JSON.stringify(ordered(value));
}

function pinned(name: string): OracleCard {
  return fixture.cards.find((entry) => entry.card.name === name)!.card;
}

function pod(seed: string, seats = 2): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: seats }, () => ({ cards: copies(8, forest) })),
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

function playerOf(ctx: GameContext, id: string) {
  return ctx.state.players.find((player) => player.id === id)!;
}

function sourceOf(card: OracleCard, cardId = `src-${card.name}`) {
  return { cardId, name: card.name, oracleId: card.oracleId, controllerId: 'P1' as const };
}

function ox(): OracleCard {
  return oracle({
    name: 'Ox',
    typeLine: 'Creature — Ox',
    manaCost: '{4}',
    power: '4',
    toughness: '4',
  });
}

function resolvePending(
  ctx: GameContext,
  chooser?: Parameters<typeof pump>[1],
  targets: string[] = [],
): void {
  const pending = ctx.state.pendingTriggers[0];
  if (pending === undefined) return;
  ctx.state.pendingTriggers.shift();
  pump(
    executeAbility(
      ctx,
      {
        cardId: pending.sourceCardId,
        name: pending.sourceName,
        oracleId: pending.sourceOracleId,
        controllerId: pending.controllerId,
      },
      pending.ability,
      targets,
      pending.triggerObjectCardId,
      pending.scope,
    ),
    chooser,
  );
}

describe('Draconic engine-evidence batch 1 (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-11',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Shamanic Revelation',
      'Akoum Hellkite',
      'Blossoming Defense',
      'Chain Reaction',
      'Game Trail',
      'Magmaquake',
      'Savage Ventmaw',
      'Unleash Fury',
    ]);
    for (const entry of fixture.cards) {
      expect(entry.card.oracleId).not.toMatch(/^oracle-/);
      expect(entry.card.oracleText.length, entry.card.name).toBeGreaterThan(20);
      expect(
        createHash('sha256').update(canonical(entry.card)).digest('hex'),
        entry.card.name,
      ).toBe(entry.sha256);
    }
  });

  it('models the complete pinned Oracle text for real and fixture IDs', () => {
    for (const { card } of fixture.cards) {
      for (const candidate of [card, { ...card, oracleId: fixtureOracleId(card.name) }]) {
        const def = interpretCard(candidate);
        expect(def.modeled, `${card.name} (${candidate.oracleId})`).toBe(true);
        expect(def.unmodeledReasons, card.name).toEqual([]);
      }
    }
  });
});

describe('Shamanic Revelation', () => {
  const card = pinned('Shamanic Revelation');

  it('revelation-draws-for-creatures-and-gains-life-for-power-4', () => {
    const ctx = pod('revelation-positive');
    spawn(ctx, 'P1', bear());
    spawn(ctx, 'P1', ox());
    spawn(ctx, 'P2', ox());
    const hand = playerOf(ctx, 'P1').hand.length;
    const life = playerOf(ctx, 'P1').life;
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, []));
    expect(playerOf(ctx, 'P1').hand.length).toBe(hand + 2);
    expect(playerOf(ctx, 'P1').life).toBe(life + 4);
  });

  it('revelation-does-nothing-without-creatures-you-control', () => {
    const ctx = pod('revelation-empty');
    spawn(ctx, 'P2', ox());
    const hand = playerOf(ctx, 'P1').hand.length;
    const life = playerOf(ctx, 'P1').life;
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, []));
    expect(playerOf(ctx, 'P1').hand.length).toBe(hand);
    expect(playerOf(ctx, 'P1').life).toBe(life);
  });
});

describe('Akoum Hellkite', () => {
  const card = pinned('Akoum Hellkite');

  it('akoum-landfall-deals-two-if-the-land-is-a-mountain', () => {
    const ctx = pod('akoum-mountain');
    spawn(ctx, 'P1', card);
    const land = spawn(ctx, 'P1', mountain());
    const life = playerOf(ctx, 'P2').life;
    queueTriggersForEvent(ctx, 'enters', [{ permanent: land }]);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    resolvePending(ctx, undefined, ['P2']);
    expect(playerOf(ctx, 'P2').life).toBe(life - 2);
  });

  it('akoum-landfall-deals-one-for-a-non-mountain-and-ignores-opponent-lands', () => {
    const ctx = pod('akoum-forest');
    spawn(ctx, 'P1', card);
    const land = spawn(ctx, 'P1', forest());
    const life = playerOf(ctx, 'P2').life;
    queueTriggersForEvent(ctx, 'enters', [{ permanent: land }]);
    resolvePending(ctx, undefined, ['P2']);
    expect(playerOf(ctx, 'P2').life).toBe(life - 1);

    const ctx2 = pod('akoum-opp');
    spawn(ctx2, 'P1', card);
    const theirs = spawn(ctx2, 'P2', mountain());
    queueTriggersForEvent(ctx2, 'enters', [{ permanent: theirs }]);
    expect(ctx2.state.pendingTriggers).toHaveLength(0);
  });
});

describe('Blossoming Defense', () => {
  const card = pinned('Blossoming Defense');

  it('defense-interpreter-reads-the-pump-without-an-override', () => {
    expect(getOverride(card.oracleId)).toBeUndefined();
    const definition = interpretCard(card);
    expect(definition.modeled).toBe(true);
    expect(definition.spellAbility?.targets).toEqual([{ kind: 'creature', controller: 'you' }]);
  });

  it('defense-pumps-and-grants-hexproof-to-your-creature', () => {
    const ctx = pod('defense-you');
    const ally = spawn(ctx, 'P1', bear());
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, [ally.id]));
    const chars = computeCharacteristics(ctx, ally);
    expect(chars.power).toBe(4);
    expect(chars.toughness).toBe(4);
    expect(chars.keywords).toContain('hexproof');
  });

  it('defense-cannot-target-an-opponent-creature', () => {
    const ctx = pod('defense-illegal');
    const ally = spawn(ctx, 'P1', bear());
    const enemy = spawn(ctx, 'P2', bear());
    const legal = computeTargetOptions(ctx, { kind: 'creature', controller: 'you' }, 'P1');
    expect(legal).toContain(ally.id);
    expect(legal).not.toContain(enemy.id);
  });
});

describe('Chain Reaction', () => {
  const card = pinned('Chain Reaction');

  it('chain-damages-each-creature-equal-to-creature-count', () => {
    const ctx = pod('chain-two');
    const yours = spawn(ctx, 'P1', bear());
    const theirs = spawn(ctx, 'P2', bear());
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, []));
    expect(yours.damageMarked).toBe(2);
    expect(theirs.damageMarked).toBe(2);
  });

  it('chain-deals-zero-when-there-are-no-creatures', () => {
    const ctx = pod('chain-zero');
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, []));
    expect(ctx.state.battlefield).toHaveLength(0);
  });
});

describe('Game Trail', () => {
  const card = pinned('Game Trail');

  it('trail-enters-untapped-when-you-reveal-a-mountain-or-forest', () => {
    const ctx = pod('trail-reveal');
    conjure(ctx, 'P1', mountain(), 'hand');
    const land = conjure(ctx, 'P1', card, 'hand');
    const { value: perm } = pump(moveObject(ctx, land, { zone: 'battlefield' }), (decision) =>
      pick(decision, 'Reveal'),
    );
    expect((perm as { tapped: boolean }).tapped).toBe(false);
  });

  it('trail-enters-tapped-when-you-decline-or-have-no-qualifying-card', () => {
    const ctx = pod('trail-decline');
    conjure(ctx, 'P1', forest(), 'hand');
    const first = conjure(ctx, 'P1', card, 'hand');
    const { value: declined } = pump(moveObject(ctx, first, { zone: 'battlefield' }), (decision) =>
      pick(decision, "Don't reveal"),
    );
    expect((declined as { tapped: boolean }).tapped).toBe(true);

    const ctx2 = pod('trail-plains');
    conjure(ctx2, 'P1', oracle({ name: 'Plains', typeLine: 'Basic Land — Plains' }), 'hand');
    const second = conjure(ctx2, 'P1', card, 'hand');
    const { value: plainsOnly } = pump(moveObject(ctx2, second, { zone: 'battlefield' }));
    expect((plainsOnly as { tapped: boolean }).tapped).toBe(true);
  });

  it('trail-normal-play-from-hand', () => {
    const ctx = pod('trail-play');
    conjure(ctx, 'P1', forest(), 'hand');
    const land = conjure(ctx, 'P1', card, 'hand');
    const play = computePriorityOptions(ctx, playerOf(ctx, 'P1')).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'playLand' && payload.objectId === land.id;
    });
    expect(play).toBeDefined();
    pump(
      applyPriorityAction(ctx, playerOf(ctx, 'P1'), play!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
      (decision) => pick(decision, 'Reveal'),
    );
    const perm = ctx.state.battlefield.find((permanent) => permanent.cardId === land.cardId);
    expect(perm?.tapped).toBe(false);
  });
});

describe('Magmaquake', () => {
  const card = pinned('Magmaquake');

  it('magmaquake-damages-nonflying-creatures-and-planeswalkers-for-x', () => {
    const ctx = pod('quake-x2');
    const walker = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Test Walker',
        typeLine: 'Legendary Planeswalker — Test',
        loyalty: '5',
        power: null,
        toughness: null,
      }),
    );
    walker.counters['loyalty'] = 5;
    const ground = spawn(ctx, 'P1', bear());
    const hawk = spawn(ctx, 'P1', keywordCreature('Hawk', 'Flying', '{W}', '1/1'));
    pump(
      executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, [], undefined, {
        x: 2,
      }),
    );
    expect(ground.damageMarked).toBe(2);
    expect(hawk.damageMarked).toBe(0);
    expect(walker.counters['loyalty']).toBe(3);
  });

  it('magmaquake-x-zero-deals-no-damage', () => {
    const ctx = pod('quake-zero');
    const ground = spawn(ctx, 'P1', bear());
    pump(
      executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, [], undefined, {
        x: 0,
      }),
    );
    expect(ground.damageMarked).toBe(0);
  });
});

describe('Savage Ventmaw', () => {
  const card = pinned('Savage Ventmaw');

  it('ventmaw-attack-adds-persistent-red-and-green', () => {
    const ctx = pod('ventmaw-attack');
    const dragon = spawn(ctx, 'P1', card);
    dragon.attacking = 'P2';
    queueTriggersForEvent(ctx, 'attacks', [{ permanent: dragon, playerId: 'P2' }]);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    resolvePending(ctx);
    const entries = playerOf(ctx, 'P1').manaEntries;
    expect(
      entries
        .map((entry) => entry.symbol)
        .sort()
        .join(''),
    ).toBe('GGGRRR');
    expect(entries.every((entry) => entry.persistent === true)).toBe(true);
  });

  it('ventmaw-does-not-trigger-for-another-attacker', () => {
    const ctx = pod('ventmaw-other');
    spawn(ctx, 'P1', card);
    const other = spawn(ctx, 'P1', bear());
    other.attacking = 'P2';
    queueTriggersForEvent(ctx, 'attacks', [{ permanent: other, playerId: 'P2' }]);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });
});

describe('Unleash Fury', () => {
  const card = pinned('Unleash Fury');

  it('fury-doubles-target-power-until-end-of-turn', () => {
    const ctx = pod('fury-double');
    const ally = spawn(ctx, 'P1', bear());
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, [ally.id]));
    expect(computeCharacteristics(ctx, ally).power).toBe(4);
    expect(computeCharacteristics(ctx, ally).toughness).toBe(2);
  });

  it('fury-normal-cast-from-hand', () => {
    const ctx = pod('fury-cast');
    spawn(ctx, 'P1', mountain());
    spawn(ctx, 'P1', forest());
    const ally = spawn(ctx, 'P1', bear());
    const spell = conjure(ctx, 'P1', card, 'hand');
    const cast = computePriorityOptions(ctx, playerOf(ctx, 'P1')).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === spell.id;
    });
    expect(cast).toBeDefined();
    pump(
      applyPriorityAction(ctx, playerOf(ctx, 'P1'), cast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, ally.id]]),
      }),
    );
    pump(resolveTopOfStack(ctx));
    expect(computeCharacteristics(ctx, ally).power).toBe(4);
  });
});
