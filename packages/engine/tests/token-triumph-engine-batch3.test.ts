import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { resolveTopOfStack } from '../src/stack/stack';
import { fixtureOracleId } from '../src/cards/overrides';
import { computeCharacteristics } from '../src/effects/continuous';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { queueTriggersForEvent } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { queueStepTriggers } from '../src/turn/turn';
import { bear, copies, forest, gameConfig, pump, spawn } from './fixtures';

interface PinnedFixture {
  schemaVersion: number;
  source: string;
  retrievedAt: string;
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/token-triumph-engine-batch3-oracle.json'),
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

describe('Token Triumph engine-evidence batch 3 (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-11',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Ajani, Caller of the Pride',
      'Trostani Discordant',
      'Felidar Retreat',
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

describe('Ajani, Caller of the Pride', () => {
  const card = pinned('Ajani, Caller of the Pride');

  it('ajani-plus-one-puts-a-counter-or-can-choose-none', () => {
    const ctx = pod('ajani-plus');
    const ajani = spawn(ctx, 'P1', card);
    ajani.counters['loyalty'] = 4;
    const ally = spawn(ctx, 'P1', bear());
    pump(
      executeAbility(
        ctx,
        sourceOf(card, ajani.cardId),
        interpretCard(card).activatedAbilities[0]!.ability,
        [],
        undefined,
        undefined,
        { 0: [ally.id] },
      ),
    );
    expect(ally.counters['+1/+1']).toBe(1);

    const ctx2 = pod('ajani-none');
    const ajani2 = spawn(ctx2, 'P1', card);
    const other = spawn(ctx2, 'P1', bear());
    pump(
      executeAbility(
        ctx2,
        sourceOf(card, ajani2.cardId),
        interpretCard(card).activatedAbilities[0]!.ability,
        [],
      ),
    );
    expect(other.counters['+1/+1'] ?? 0).toBe(0);
  });

  it('announces zero or one target through the normal loyalty activation path', () => {
    for (const chooseTarget of [true, false]) {
      const ctx = pod(`ajani-announcement-${chooseTarget}`);
      const ajani = spawn(ctx, 'P1', card);
      ajani.counters['loyalty'] = 4;
      const ally = spawn(ctx, 'P1', bear());
      const action = computePriorityOptions(ctx, playerOf(ctx, 'P1')).find((option) => {
        const payload = option.payload as PriorityActionPayload;
        return (
          payload.kind === 'activateAbility' && payload.objectId === ajani.id && payload.index === 0
        );
      });
      expect(action).toBeDefined();
      expect(action?.targets).toBeUndefined();
      const { decisions } = pump(
        applyPriorityAction(ctx, playerOf(ctx, 'P1'), action!.payload as PriorityActionPayload, {
          index: 0,
          targets: new Map(),
        }),
        (decision) => ({
          index: decision.options.findIndex((option) =>
            chooseTarget
              ? option.description.includes('Target')
              : option.description.includes('no more'),
          ),
          targets: new Map(),
        }),
      );
      expect(decisions).toHaveLength(1);
      expect(ctx.state.stack[0]?.countTargets?.[0]).toEqual(chooseTarget ? [ally.id] : []);
      pump(resolveTopOfStack(ctx));
      expect(ally.counters['+1/+1'] ?? 0).toBe(chooseTarget ? 1 : 0);
      expect(ajani.counters['loyalty']).toBe(5);
    }
  });

  it('ajani-minus-three-grants-flying-and-double-strike-minus-eight-makes-cats-equal-to-life', () => {
    const ctx = pod('ajani-minus3');
    const ajani = spawn(ctx, 'P1', card);
    const ally = spawn(ctx, 'P1', bear());
    pump(
      executeAbility(
        ctx,
        sourceOf(card, ajani.cardId),
        interpretCard(card).activatedAbilities[1]!.ability,
        [ally.id],
      ),
    );
    const chars = computeCharacteristics(ctx, ally);
    expect(chars.keywords).toContain('flying');
    expect(chars.keywords).toContain('double strike');

    const ctx2 = pod('ajani-ultimate');
    const ajani2 = spawn(ctx2, 'P1', card);
    ajani2.counters['loyalty'] = 8;
    playerOf(ctx2, 'P1').life = 2;
    pump(
      executeAbility(
        ctx2,
        sourceOf(card, ajani2.cardId),
        interpretCard(card).activatedAbilities[2]!.ability,
        [],
      ),
    );
    expect(ctx2.state.battlefield.filter((permanent) => permanent.name === 'Cat')).toHaveLength(2);
  });
});

describe('Trostani Discordant', () => {
  const card = pinned('Trostani Discordant');

  it('trostani-etb-makes-two-lifelink-soldiers-and-anthem-pumps-yours', () => {
    const ctx = pod('trostani-etb');
    const trostani = spawn(ctx, 'P1', card);
    const ally = spawn(ctx, 'P1', bear());
    const enemy = spawn(ctx, 'P2', bear());
    pump(
      executeAbility(ctx, sourceOf(card, trostani.cardId), interpretCard(card).triggers[0]!, []),
    );
    const soldiers = ctx.state.battlefield.filter(
      (permanent) => permanent.name === 'Soldier' && permanent.controllerId === 'P1',
    );
    expect(soldiers).toHaveLength(2);
    expect(
      soldiers.every((permanent) =>
        computeCharacteristics(ctx, permanent).keywords.includes('lifelink'),
      ),
    ).toBe(true);
    expect(computeCharacteristics(ctx, ally).power).toBe(3);
    expect(computeCharacteristics(ctx, enemy).power).toBe(2);
  });

  it('trostani-end-step-returns-your-stolen-creatures-and-ignores-opponent-end-step', () => {
    const ctx = pod('trostani-end');
    spawn(ctx, 'P1', card);
    const stolen = spawn(ctx, 'P1', bear());
    stolen.controllerId = 'P2';
    queueStepTriggers(ctx, 'endStep');
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    resolvePending(ctx);
    expect(stolen.controllerId).toBe('P1');

    const ctx2 = pod('trostani-opp-end');
    spawn(ctx2, 'P1', card);
    ctx2.state.currentTurnPlayer = 'P2';
    queueStepTriggers(ctx2, 'endStep');
    expect(ctx2.state.pendingTriggers).toHaveLength(0);
  });
});

describe('Felidar Retreat', () => {
  const card = pinned('Felidar Retreat');

  it('felidar-landfall-can-make-a-cat-beast-or-pump-with-vigilance', () => {
    const ctx = pod('felidar-token');
    spawn(ctx, 'P1', card);
    const land = spawn(ctx, 'P1', forest());
    queueTriggersForEvent(ctx, 'enters', [{ permanent: land }]);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    resolvePending(ctx, () => ({ index: 0, targets: new Map() }));
    expect(ctx.state.battlefield.some((permanent) => permanent.name === 'Cat Beast')).toBe(true);

    const ctx2 = pod('felidar-pump');
    spawn(ctx2, 'P1', card);
    const ally = spawn(ctx2, 'P1', bear());
    const enemy = spawn(ctx2, 'P2', bear());
    const land2 = spawn(ctx2, 'P1', forest());
    queueTriggersForEvent(ctx2, 'enters', [{ permanent: land2 }]);
    resolvePending(ctx2, () => ({ index: 1, targets: new Map() }));
    expect(ally.counters['+1/+1']).toBe(1);
    expect(computeCharacteristics(ctx2, ally).keywords).toContain('vigilance');
    expect(enemy.counters['+1/+1'] ?? 0).toBe(0);
  });

  it('felidar-does-not-trigger-for-an-opponent-land', () => {
    const ctx = pod('felidar-opp');
    spawn(ctx, 'P1', card);
    const land = spawn(ctx, 'P2', forest());
    queueTriggersForEvent(ctx, 'enters', [{ permanent: land }]);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });
});
