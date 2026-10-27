import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { computeCharacteristics } from '../src/effects/continuous';
import { executeAbility } from '../src/effects/resolve';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { moveObject, queueTriggersForEvent } from '../src/state/objects';
import { manaSourcesFor } from '../src/state/queries';
import type { GameContext } from '../src/state/types';
import { priorityCheckpoint } from '../src/sba/sba';
import { resolveTopOfStack } from '../src/stack/stack';
import { queueStepTriggers } from '../src/turn/turn';
import {
  bear,
  commanderFor,
  conjure,
  copies,
  forest,
  gameConfig,
  oracle,
  pick,
  plains,
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
  readFileSync(
    join(import.meta.dirname, 'fixtures/token-triumph-engine-batch1-oracle.json'),
    'utf8',
  ),
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

function resolvePending(ctx: GameContext, chooser?: Parameters<typeof pump>[1]): void {
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
      [],
      pending.triggerObjectCardId,
      pending.scope,
    ),
    chooser,
  );
}

function fund(ctx: GameContext, playerId: string): void {
  addMana(
    playerOf(ctx, playerId),
    Array.from({ length: 8 }, () => ({ symbol: 'C' as const })),
  );
}

describe('Token Triumph engine-evidence batch 1 (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-11',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Leafkin Druid',
      'Fortified Village',
      'Overwhelming Instinct',
      'Mentor of the Meek',
      "Commander's Insignia",
      'Loyal Guardian',
      'Great Oak Guardian',
      'Citywide Bust',
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

describe('Leafkin Druid', () => {
  const card = pinned('Leafkin Druid');

  it('leafkin-taps-for-one-green-below-four-creatures', () => {
    const ctx = pod('leafkin-one');
    const druid = spawn(ctx, 'P1', card);
    spawn(ctx, 'P1', bear());
    spawn(ctx, 'P2', bear());
    spawn(ctx, 'P2', bear());
    spawn(ctx, 'P2', bear());
    const source = manaSourcesFor(ctx, 'P1').find((entry) => entry.cardId === druid.cardId);
    expect(source?.units).toEqual([['G']]);
  });

  it('leafkin-taps-for-two-green-with-four-creatures-you-control', () => {
    const ctx = pod('leafkin-two');
    const druid = spawn(ctx, 'P1', card);
    spawn(ctx, 'P1', bear());
    spawn(ctx, 'P1', bear());
    spawn(ctx, 'P1', bear());
    const source = manaSourcesFor(ctx, 'P1').find((entry) => entry.cardId === druid.cardId);
    expect(source?.units).toEqual([['G'], ['G']]);
  });
});

describe('Fortified Village', () => {
  const card = pinned('Fortified Village');

  it('village-enters-untapped-when-you-reveal-a-forest-or-plains', () => {
    const ctx = pod('village-reveal');
    conjure(ctx, 'P1', forest(), 'hand');
    const land = conjure(ctx, 'P1', card, 'hand');
    const { value: perm } = pump(moveObject(ctx, land, { zone: 'battlefield' }), (decision) =>
      pick(decision, 'Reveal'),
    );
    expect((perm as { tapped: boolean }).tapped).toBe(false);
  });

  it('village-enters-tapped-when-you-decline-or-have-no-qualifying-card', () => {
    const ctx = pod('village-decline');
    conjure(ctx, 'P1', plains(), 'hand');
    const first = conjure(ctx, 'P1', card, 'hand');
    const { value: declined } = pump(moveObject(ctx, first, { zone: 'battlefield' }), (decision) =>
      pick(decision, "Don't reveal"),
    );
    expect((declined as { tapped: boolean }).tapped).toBe(true);

    const ctx2 = pod('village-island');
    conjure(ctx2, 'P1', oracle({ name: 'Island', typeLine: 'Basic Land — Island' }), 'hand');
    const second = conjure(ctx2, 'P1', card, 'hand');
    const { value: islandOnly } = pump(moveObject(ctx2, second, { zone: 'battlefield' }));
    expect((islandOnly as { tapped: boolean }).tapped).toBe(true);
  });

  it('village-does-not-count-an-opponent-forest-in-their-hand', () => {
    const ctx = pod('village-opponent-hand');
    conjure(ctx, 'P2', forest(), 'hand');
    const land = conjure(ctx, 'P1', card, 'hand');
    const { value: perm } = pump(moveObject(ctx, land, { zone: 'battlefield' }));
    expect((perm as { tapped: boolean }).tapped).toBe(true);
  });

  it('village-normal-play-from-hand', () => {
    const ctx = pod('village-play');
    conjure(ctx, 'P1', plains(), 'hand');
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

describe('Overwhelming Instinct', () => {
  const card = pinned('Overwhelming Instinct');

  it('instinct-draws-when-you-attack-with-three-or-more', () => {
    const ctx = pod('instinct-three');
    spawn(ctx, 'P1', card);
    const attackers = [
      spawn(ctx, 'P1', bear()),
      spawn(ctx, 'P1', bear()),
      spawn(ctx, 'P1', bear()),
    ];
    for (const attacker of attackers) attacker.attacking = 'P2';
    const hand = playerOf(ctx, 'P1').hand.length;
    queueTriggersForEvent(
      ctx,
      'attacks',
      attackers.map((permanent) => ({ permanent, playerId: 'P2' })),
    );
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    resolvePending(ctx);
    expect(playerOf(ctx, 'P1').hand.length).toBe(hand + 1);
  });

  it('instinct-still-draws-after-an-attacker-leaves-combat', () => {
    // The card has no "if": the attack count qualifies the event and is not rechecked on
    // resolution (CR 603.4 applies only to intervening-if clauses).
    const ctx = pod('instinct-removed');
    spawn(ctx, 'P1', card);
    const attackers = [
      spawn(ctx, 'P1', bear()),
      spawn(ctx, 'P1', bear()),
      spawn(ctx, 'P1', bear()),
    ];
    for (const attacker of attackers) attacker.attacking = 'P2';
    const hand = playerOf(ctx, 'P1').hand.length;
    queueTriggersForEvent(
      ctx,
      'attacks',
      attackers.map((permanent) => ({ permanent, playerId: 'P2' })),
    );
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.stack).toHaveLength(1);
    attackers[0]!.attacking = null;
    pump(resolveTopOfStack(ctx));
    expect(playerOf(ctx, 'P1').hand.length).toBe(hand + 1);
  });

  it('instinct-does-not-draw-for-two-attackers-or-an-opponent-attack', () => {
    const ctx = pod('instinct-two');
    spawn(ctx, 'P1', card);
    const a = spawn(ctx, 'P1', bear());
    const b = spawn(ctx, 'P1', bear());
    a.attacking = 'P2';
    b.attacking = 'P2';
    queueTriggersForEvent(ctx, 'attacks', [
      { permanent: a, playerId: 'P2' },
      { permanent: b, playerId: 'P2' },
    ]);
    expect(ctx.state.pendingTriggers).toHaveLength(0);

    const ctx2 = pod('instinct-opp');
    spawn(ctx2, 'P1', card);
    const theirs = [
      spawn(ctx2, 'P2', bear()),
      spawn(ctx2, 'P2', bear()),
      spawn(ctx2, 'P2', bear()),
    ];
    for (const attacker of theirs) attacker.attacking = 'P1';
    queueTriggersForEvent(
      ctx2,
      'attacks',
      theirs.map((permanent) => ({ permanent, playerId: 'P1' })),
    );
    expect(ctx2.state.pendingTriggers).toHaveLength(0);
  });
});

describe('Mentor of the Meek', () => {
  const card = pinned('Mentor of the Meek');

  it('mentor-may-pay-one-to-draw-when-another-power-2-or-less-enters', () => {
    const ctx = pod('mentor-draw');
    spawn(ctx, 'P1', card);
    fund(ctx, 'P1');
    const hand = playerOf(ctx, 'P1').hand.length;
    const cub = conjure(ctx, 'P1', bear(), 'hand');
    pump(moveObject(ctx, cub, { zone: 'battlefield', controllerId: 'P1' }));
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    resolvePending(ctx, (decision) => pick(decision, 'Pay {1}'));
    expect(playerOf(ctx, 'P1').hand.length).toBe(hand + 1);
  });

  it('mentor-does-not-trigger-for-power-3-or-an-opponent-creature', () => {
    const ctx = pod('mentor-ox');
    spawn(ctx, 'P1', card);
    const brute = conjure(ctx, 'P1', ox(), 'hand');
    pump(moveObject(ctx, brute, { zone: 'battlefield', controllerId: 'P1' }));
    expect(ctx.state.pendingTriggers).toHaveLength(0);

    const ctx2 = pod('mentor-opp');
    spawn(ctx2, 'P1', card);
    const theirs = conjure(ctx2, 'P2', bear(), 'hand');
    pump(moveObject(ctx2, theirs, { zone: 'battlefield', controllerId: 'P2' }));
    expect(ctx2.state.pendingTriggers).toHaveLength(0);
  });
});

describe("Commander's Insignia", () => {
  const card = pinned("Commander's Insignia");

  it('insignia-pumps-your-creatures-by-commander-cast-count', () => {
    const ctx = pod('insignia-pump');
    spawn(ctx, 'P1', card);
    const yours = spawn(ctx, 'P1', bear());
    const theirs = spawn(ctx, 'P2', bear());
    expect(computeCharacteristics(ctx, yours).power).toBe(2);
    playerOf(ctx, 'P1').commanderCastCount['commander-card-1'] = 2;
    expect(computeCharacteristics(ctx, yours).power).toBe(4);
    expect(computeCharacteristics(ctx, theirs).power).toBe(2);
  });

  it('insignia-does-not-pump-when-you-have-not-cast-a-commander', () => {
    const ctx = pod('insignia-zero');
    spawn(ctx, 'P1', card);
    const yours = spawn(ctx, 'P1', bear());
    expect(computeCharacteristics(ctx, yours).power).toBe(2);
  });
});

describe('Loyal Guardian', () => {
  const card = pinned('Loyal Guardian');

  it('guardian-puts-counters-at-begin-combat-if-you-control-your-commander', () => {
    const ctx = pod('guardian-yes');
    const guardian = spawn(ctx, 'P1', card);
    const ally = spawn(ctx, 'P1', bear());
    const enemy = spawn(ctx, 'P2', bear());
    spawn(ctx, 'P1', commanderFor('G', 'Test Hero'), { isCommander: true });
    queueStepTriggers(ctx, 'beginningOfCombat');
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    resolvePending(ctx);
    expect(guardian.counters['+1/+1'] ?? 0).toBe(1);
    expect(ally.counters['+1/+1'] ?? 0).toBe(1);
    expect(enemy.counters['+1/+1'] ?? 0).toBe(0);
  });

  it('guardian-does-not-fire-without-your-commander-or-on-an-opponent-turn', () => {
    const ctx = pod('guardian-no-cmd');
    spawn(ctx, 'P1', card);
    spawn(ctx, 'P2', commanderFor('G', 'Enemy Hero'), { isCommander: true });
    queueStepTriggers(ctx, 'beginningOfCombat');
    expect(ctx.state.pendingTriggers).toHaveLength(0);

    const ctx2 = pod('guardian-opp-turn');
    spawn(ctx2, 'P1', card);
    spawn(ctx2, 'P1', commanderFor('G', 'Test Hero'), { isCommander: true });
    ctx2.state.currentTurnPlayer = 'P2';
    queueStepTriggers(ctx2, 'beginningOfCombat');
    expect(ctx2.state.pendingTriggers).toHaveLength(0);
  });
});

describe('Great Oak Guardian', () => {
  const card = pinned('Great Oak Guardian');

  it('oak-untaps-and-pumps-the-targeted-players-creatures', () => {
    const ctx = pod('oak-you');
    const ally = spawn(ctx, 'P1', bear(), { tapped: true });
    const enemy = spawn(ctx, 'P2', bear(), { tapped: true });
    const oak = spawn(ctx, 'P1', card);
    pump(executeAbility(ctx, sourceOf(card, oak.cardId), interpretCard(card).triggers[0]!, ['P1']));
    expect(ally.tapped).toBe(false);
    expect(enemy.tapped).toBe(true);
    expect(computeCharacteristics(ctx, ally).power).toBe(4);
    expect(computeCharacteristics(ctx, enemy).power).toBe(2);
  });

  it('oak-does-not-pump-the-untargeted-player', () => {
    const ctx = pod('oak-them');
    const ally = spawn(ctx, 'P1', bear(), { tapped: true });
    const enemy = spawn(ctx, 'P2', bear(), { tapped: true });
    const oak = spawn(ctx, 'P1', card);
    pump(executeAbility(ctx, sourceOf(card, oak.cardId), interpretCard(card).triggers[0]!, ['P2']));
    expect(enemy.tapped).toBe(false);
    expect(ally.tapped).toBe(true);
    expect(computeCharacteristics(ctx, enemy).power).toBe(4);
    expect(computeCharacteristics(ctx, ally).power).toBe(2);
  });
});

describe('Citywide Bust', () => {
  const card = pinned('Citywide Bust');

  it('bust-destroys-toughness-4-or-greater-and-spares-smaller', () => {
    const ctx = pod('bust-destroy');
    const big = spawn(ctx, 'P2', ox());
    const small = spawn(ctx, 'P1', bear());
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, []));
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === big.cardId)).toBe(false);
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === small.cardId)).toBe(true);
  });

  it('bust-normal-cast-from-hand', () => {
    const ctx = pod('bust-cast');
    spawn(ctx, 'P1', plains());
    spawn(ctx, 'P1', plains());
    spawn(ctx, 'P1', forest());
    const big = spawn(ctx, 'P2', ox());
    const spell = conjure(ctx, 'P1', card, 'hand');
    const cast = computePriorityOptions(ctx, playerOf(ctx, 'P1')).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === spell.id;
    });
    expect(cast).toBeDefined();
    pump(
      applyPriorityAction(ctx, playerOf(ctx, 'P1'), cast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === big.cardId)).toBe(false);
  });
});
