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
import { fixtureOracleId } from '../src/cards/overrides';
import { computeCharacteristics } from '../src/effects/continuous';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { queueStepTriggers } from '../src/turn/turn';
import { bear, conjure, copies, forest, gameConfig, oracle, plains, pump, spawn } from './fixtures';

interface PinnedFixture {
  schemaVersion: number;
  source: string;
  retrievedAt: string;
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/queen-engine-batch2-oracle.json'), 'utf8'),
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

function sourceOf(card: OracleCard) {
  return {
    cardId: `src-${card.name}`,
    name: card.name,
    oracleId: card.oracleId,
    controllerId: 'P1' as const,
  };
}

function resolveSpell(ctx: GameContext, card: OracleCard, targets: string[]): void {
  pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, targets));
}

function playFromHand(ctx: GameContext, controllerId: 'P1' | 'P2', card: OracleCard) {
  const obj = conjure(ctx, controllerId, card, 'hand');
  pump(moveObject(ctx, obj, { zone: 'battlefield', controllerId }));
  return obj;
}

describe('Queen engine-evidence batch 2 (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-11',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Generous Gift',
      'Stroke of Midnight',
      'Swords to Plowshares',
      'Queen Marchesa',
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

describe('Generous Gift', () => {
  const card = pinned('Generous Gift');

  it('gift-destroys-and-makes-elephant: the controller of the destroyed permanent gets a 3/3 Elephant', () => {
    const ctx = pod('gift-destroy');
    const victim = spawn(ctx, 'P2', bear());
    resolveSpell(ctx, card, [victim.id]);
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === victim.cardId)).toBe(
      false,
    );
    expect(playerOf(ctx, 'P2').graveyard.some((object) => object.cardId === victim.cardId)).toBe(
      true,
    );
    const elephant = ctx.state.battlefield.find((permanent) => permanent.name === 'Elephant');
    expect(elephant?.controllerId).toBe('P2');
    expect(elephant?.power).toBe(3);
    expect(elephant?.toughness).toBe(3);
  });

  it('gift-can-target-a-land: a land is a legal target', () => {
    const ctx = pod('gift-land');
    const land = spawn(ctx, 'P2', forest());
    const legal = computeTargetOptions(ctx, { kind: 'permanent' }, 'P1');
    expect(legal).toContain(land.id);
    resolveSpell(ctx, card, [land.id]);
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === land.cardId)).toBe(false);
    expect(ctx.state.battlefield.some((permanent) => permanent.name === 'Elephant')).toBe(true);
  });
});

describe('Stroke of Midnight', () => {
  const card = pinned('Stroke of Midnight');

  it('stroke-destroys-nonland-and-makes-human', () => {
    const ctx = pod('stroke-destroy');
    const victim = spawn(ctx, 'P2', bear());
    resolveSpell(ctx, card, [victim.id]);
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === victim.cardId)).toBe(
      false,
    );
    const human = ctx.state.battlefield.find((permanent) => permanent.name === 'Human');
    expect(human?.controllerId).toBe('P2');
    expect(human?.power).toBe(1);
    expect(human?.toughness).toBe(1);
  });

  it('stroke-cannot-target-a-land', () => {
    const ctx = pod('stroke-land');
    const land = spawn(ctx, 'P2', forest());
    const creature = spawn(ctx, 'P2', bear());
    const legal = computeTargetOptions(ctx, { kind: 'nonlandPermanent' }, 'P1');
    expect(legal).toContain(creature.id);
    expect(legal).not.toContain(land.id);
  });
});

describe('Swords to Plowshares', () => {
  const card = pinned('Swords to Plowshares');

  it('swords-exiles-and-gains-life-equal-to-power', () => {
    const ctx = pod('swords-exile');
    const victim = spawn(
      ctx,
      'P2',
      oracle({ name: 'Ox', typeLine: 'Creature — Ox', power: '4', toughness: '4' }),
    );
    const life = playerOf(ctx, 'P2').life;
    resolveSpell(ctx, card, [victim.id]);
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === victim.cardId)).toBe(
      false,
    );
    expect(ctx.state.exile.some((object) => object.cardId === victim.cardId)).toBe(true);
    expect(playerOf(ctx, 'P2').graveyard.some((object) => object.cardId === victim.cardId)).toBe(
      false,
    );
    expect(playerOf(ctx, 'P2').life).toBe(life + 4);
  });

  it('swords-cannot-target-a-noncreature', () => {
    const ctx = pod('swords-land');
    const land = spawn(ctx, 'P2', forest());
    const creature = spawn(ctx, 'P2', bear());
    const legal = computeTargetOptions(ctx, { kind: 'creature' }, 'P1');
    expect(legal).toContain(creature.id);
    expect(legal).not.toContain(land.id);
  });

  it('swords-normal-cast-from-hand', () => {
    const ctx = pod('swords-cast');
    spawn(ctx, 'P1', plains());
    const victim = spawn(ctx, 'P2', bear());
    const spell = conjure(ctx, 'P1', card, 'hand');
    const p1 = playerOf(ctx, 'P1');
    const cast = computePriorityOptions(ctx, p1).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === spell.id;
    });
    expect(cast).toBeDefined();
    pump(
      applyPriorityAction(ctx, p1, cast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, victim.id]]),
      }),
    );
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.exile.some((object) => object.cardId === victim.cardId)).toBe(true);
  });
});

describe('Queen Marchesa', () => {
  const card = pinned('Queen Marchesa');

  it('queen-etb-makes-you-monarch', () => {
    const ctx = pod('queen-etb');
    playFromHand(ctx, 'P1', card);
    pump(runPrioritySequence(ctx));
    expect(ctx.state.monarchPlayerId).toBe('P1');
  });

  it('queen-upkeep-assassin-if-opponent-is-monarch', () => {
    const ctx = pod('queen-assassin');
    spawn(ctx, 'P1', card);
    ctx.state.monarchPlayerId = 'P2';
    queueStepTriggers(ctx, 'upkeep');
    pump(runPrioritySequence(ctx));
    const assassin = ctx.state.battlefield.find((permanent) => permanent.name === 'Assassin');
    expect(assassin?.controllerId).toBe('P1');
    expect(computeCharacteristics(ctx, assassin!).keywords).toEqual(
      expect.arrayContaining(['deathtouch', 'haste']),
    );
  });

  it('queen-upkeep-no-assassin-if-you-are-monarch', () => {
    const ctx = pod('queen-no-assassin');
    spawn(ctx, 'P1', card);
    ctx.state.monarchPlayerId = 'P1';
    queueStepTriggers(ctx, 'upkeep');
    pump(runPrioritySequence(ctx));
    expect(ctx.state.battlefield.some((permanent) => permanent.name === 'Assassin')).toBe(false);
  });
});
