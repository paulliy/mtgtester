import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { computeCharacteristics } from '../src/effects/continuous';
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { runCombatPhase } from '../src/combat/combat';
import { runPrioritySequence } from '../src/turn/priority';
import { queueStepTriggers } from '../src/turn/turn';
import {
  bear,
  copies,
  conjure,
  declareAttacks,
  forest,
  gameConfig,
  oracle,
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
  readFileSync(join(import.meta.dirname, 'fixtures/marchesa-engine-batch3-oracle.json'), 'utf8'),
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

function legend(): OracleCard {
  return oracle({
    name: 'Test Legend',
    typeLine: 'Legendary Creature — Human',
    manaCost: '{2}{W}',
    power: '2',
    toughness: '2',
    supertypes: ['Legendary'],
  });
}

function declineIndex(decision: {
  options: { description: string; presentation?: { role?: string } }[];
}): number {
  return decision.options.findIndex(
    (option) => option.presentation?.role === 'decline' || option.description === 'Enter normally',
  );
}

function enterAsCopy(
  ctx: GameContext,
  card: OracleCard,
  choice: 'copy-first' | 'decline',
): ReturnType<typeof conjure> {
  const obj = conjure(ctx, 'P1', card, 'hand');
  pump(moveObject(ctx, obj, { zone: 'battlefield', controllerId: 'P1' }), (decision) => {
    if (choice === 'decline') {
      const decline = declineIndex(decision);
      if (decline < 0) {
        throw new Error(
          `no decline option in: ${decision.options.map((o) => o.description).join('; ')}`,
        );
      }
      return { index: decline, targets: new Map() };
    }
    return { index: 0, targets: new Map() };
  });
  return obj;
}

function attackP2(ctx: GameContext): void {
  ctx.state.phase = 'combat';
  pump(runCombatPhase(ctx), (decision) => {
    if (decision.decisionType === 'declareAttackers') {
      return declareAttacks(decision, () => 'P2');
    }
    return { index: 0, targets: new Map() };
  });
}

describe('Marchesa engine-evidence batch 3 (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-10',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      "Dack's Duplicate",
      'Kalain, Reclusive Painter',
      'Marchesa, the Black Rose',
      'Spark Double',
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

describe("Dack's Duplicate", () => {
  const card = pinned("Dack's Duplicate");

  it('dack-copy-gains-haste-and-dethrone: copying a creature adds haste and a dethrone trigger', () => {
    const ctx = pod('dack-copy');
    const host = spawn(ctx, 'P2', bear());
    enterAsCopy(ctx, card, 'copy-first');
    const copy = ctx.state.battlefield.find((permanent) => permanent.cardId !== host.cardId)!;
    expect(copy.name).toBe(host.name);
    expect(computeCharacteristics(ctx, copy).keywords).toContain('haste');
    expect(
      computeCharacteristics(ctx, copy).triggers.some((ability) =>
        ability.description?.toLowerCase().includes('dethrone'),
      ),
    ).toBe(true);
  });

  it('dack-decline-enters-normally: declining the copy choice leaves Dack’s Duplicate', () => {
    const ctx = pod('dack-decline');
    spawn(ctx, 'P1', bear());
    enterAsCopy(ctx, card, 'decline');
    expect(ctx.state.battlefield.some((permanent) => permanent.name === "Dack's Duplicate")).toBe(
      true,
    );
  });

  it('dack-noncreature-not-offered: a noncreature permanent is not a copy candidate', () => {
    const ctx = pod('dack-land');
    spawn(ctx, 'P1', forest());
    const names: string[] = [];
    const obj = conjure(ctx, 'P1', card, 'hand');
    pump(moveObject(ctx, obj, { zone: 'battlefield', controllerId: 'P1' }), (decision) => {
      names.push(...decision.options.map((option) => option.description));
      const decline = declineIndex(decision);
      return { index: decline >= 0 ? decline : 0, targets: new Map() };
    });
    expect(names.some((description) => description.includes('Forest'))).toBe(false);
    expect(ctx.state.battlefield.some((permanent) => permanent.name === "Dack's Duplicate")).toBe(
      true,
    );
  });
});

describe('Kalain, Reclusive Painter', () => {
  const card = pinned('Kalain, Reclusive Painter');

  it('kalain-treasure-mana-adds-counters: another creature you cast with Treasure mana enters with that many +1/+1 counters', () => {
    const ctx = pod('kalain-treasure');
    spawn(ctx, 'P1', card);
    const incoming = conjure(ctx, 'P1', bear(), 'hand');
    incoming.treasureManaSpentToCast = 2;
    pump(moveObject(ctx, incoming, { zone: 'battlefield', controllerId: 'P1' }));
    const creature = ctx.state.battlefield.find(
      (permanent) => permanent.cardId === incoming.cardId,
    );
    expect(creature?.counters['+1/+1']).toBe(2);
  });

  it('kalain-self-and-zero-treasure: Kalain herself and a no-Treasure creature get no extra counters', () => {
    const ctx = pod('kalain-negative');
    const kalain = conjure(ctx, 'P1', card, 'hand');
    kalain.treasureManaSpentToCast = 3;
    pump(moveObject(ctx, kalain, { zone: 'battlefield', controllerId: 'P1' }));
    const self = ctx.state.battlefield.find((permanent) => permanent.cardId === kalain.cardId);
    expect(self?.counters['+1/+1'] ?? 0).toBe(0);

    const incoming = conjure(ctx, 'P1', bear(), 'hand');
    pump(moveObject(ctx, incoming, { zone: 'battlefield', controllerId: 'P1' }));
    const creature = ctx.state.battlefield.find(
      (permanent) => permanent.cardId === incoming.cardId,
    );
    expect(creature?.counters['+1/+1'] ?? 0).toBe(0);
  });

  it('kalain-opponent-creature-ignored: an opponent creature does not get Treasure counters', () => {
    const ctx = pod('kalain-opponent');
    spawn(ctx, 'P1', card);
    const incoming = conjure(ctx, 'P2', bear(), 'hand');
    incoming.treasureManaSpentToCast = 2;
    pump(moveObject(ctx, incoming, { zone: 'battlefield', controllerId: 'P2' }));
    const creature = ctx.state.battlefield.find(
      (permanent) => permanent.cardId === incoming.cardId,
    );
    expect(creature?.counters['+1/+1'] ?? 0).toBe(0);
  });
});

describe('Marchesa, the Black Rose', () => {
  const card = pinned('Marchesa, the Black Rose');

  it('marchesa-dethrone-most-or-tied: attacking the player with most or tied-for-most life adds a counter', () => {
    const ctx = pod('marchesa-dethrone-tie', 3);
    const marchesa = spawn(ctx, 'P1', card);
    playerOf(ctx, 'P1').life = 30;
    playerOf(ctx, 'P2').life = 30;
    playerOf(ctx, 'P3').life = 20;
    attackP2(ctx);
    expect(marchesa.counters['+1/+1']).toBe(1);
  });

  it('marchesa-dethrone-not-most: attacking a player who does not have the most life does not add a counter', () => {
    const ctx = pod('marchesa-dethrone-not-most', 3);
    const marchesa = spawn(ctx, 'P1', card);
    playerOf(ctx, 'P1').life = 20;
    playerOf(ctx, 'P2').life = 30;
    playerOf(ctx, 'P3').life = 40;
    attackP2(ctx);
    expect(marchesa.counters['+1/+1'] ?? 0).toBe(0);
  });

  it('marchesa-grants-dethrone-to-others: another creature you control also gets a counter when it attacks the life leader', () => {
    const ctx = pod('marchesa-grant');
    spawn(ctx, 'P1', card);
    const ally = spawn(ctx, 'P1', bear());
    playerOf(ctx, 'P1').life = 20;
    playerOf(ctx, 'P2').life = 30;
    attackP2(ctx);
    expect(ally.counters['+1/+1']).toBe(1);
  });

  it('marchesa-does-not-grant-opponent-dethrone: an opposing creature does not get a dethrone counter', () => {
    const ctx = pod('marchesa-no-grant-opponent', 3);
    spawn(ctx, 'P1', card);
    const theirs = spawn(ctx, 'P2', bear());
    theirs.summoningSick = false;
    playerOf(ctx, 'P1').life = 40;
    playerOf(ctx, 'P2').life = 20;
    playerOf(ctx, 'P3').life = 40;
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    ctx.state.phase = 'combat';
    pump(runCombatPhase(ctx), (decision) => {
      if (decision.decisionType === 'declareAttackers') {
        return declareAttacks(decision, () => 'P1');
      }
      return { index: 0, targets: new Map() };
    });
    expect(theirs.counters['+1/+1'] ?? 0).toBe(0);
  });

  it('marchesa-your-plus-one-returns: your +1/+1 creature returns at the next end step', () => {
    const ctx = pod('marchesa-your-return');
    spawn(ctx, 'P1', card);
    const ally = spawn(ctx, 'P1', bear());
    ally.counters['+1/+1'] = 1;
    pump(moveObject(ctx, ally, { zone: 'graveyard' }));
    pump(runPrioritySequence(ctx));
    expect(ctx.state.delayedTriggers).toHaveLength(1);
    queueStepTriggers(ctx, 'endStep');
    pump(runPrioritySequence(ctx));
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === ally.cardId)).toBe(true);
  });

  it('marchesa-your-no-counter-does-not-return: a creature you control without +1/+1 does not return', () => {
    const ctx = pod('marchesa-no-counter');
    spawn(ctx, 'P1', card);
    const ally = spawn(ctx, 'P1', bear());
    pump(moveObject(ctx, ally, { zone: 'graveyard' }));
    pump(runPrioritySequence(ctx));
    expect(ctx.state.delayedTriggers).toHaveLength(0);
    queueStepTriggers(ctx, 'endStep');
    pump(runPrioritySequence(ctx));
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === ally.cardId)).toBe(false);
  });

  it('marchesa-opponent-plus-one-does-not-return: an opponent creature with +1/+1 dying is not returned', () => {
    const ctx = pod('marchesa-opponent-dies');
    spawn(ctx, 'P1', card);
    const theirs = spawn(ctx, 'P2', bear());
    theirs.counters['+1/+1'] = 1;
    pump(moveObject(ctx, theirs, { zone: 'graveyard' }));
    pump(runPrioritySequence(ctx));
    expect(ctx.state.delayedTriggers).toHaveLength(0);
    queueStepTriggers(ctx, 'endStep');
    pump(runPrioritySequence(ctx));
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === theirs.cardId)).toBe(
      false,
    );
  });
});

describe('Spark Double', () => {
  const card = pinned('Spark Double');

  it('spark-copy-yours-not-legendary-plus-counter: copying your legendary creature adds +1/+1 and is not legendary', () => {
    const ctx = pod('spark-copy');
    const host = spawn(ctx, 'P1', legend());
    enterAsCopy(ctx, card, 'copy-first');
    const copy = ctx.state.battlefield.find((permanent) => permanent.cardId !== host.cardId)!;
    expect(copy.name).toBe(host.name);
    expect(computeCharacteristics(ctx, copy).supertypes).not.toContain('Legendary');
    expect(copy.counters['+1/+1']).toBe(1);
  });

  it('spark-cannot-copy-opponent: an opponent creature is not offered', () => {
    const ctx = pod('spark-opponent');
    spawn(ctx, 'P2', bear());
    const obj = conjure(ctx, 'P1', card, 'hand');
    const names: string[] = [];
    pump(moveObject(ctx, obj, { zone: 'battlefield', controllerId: 'P1' }), (decision) => {
      names.push(...decision.options.map((option) => option.description));
      const decline = declineIndex(decision);
      return { index: decline >= 0 ? decline : 0, targets: new Map() };
    });
    expect(names.some((description) => description.includes('Test Bear'))).toBe(false);
    expect(ctx.state.battlefield.some((permanent) => permanent.name === 'Spark Double')).toBe(true);
  });
});
