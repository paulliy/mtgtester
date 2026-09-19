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
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { queueTriggersForObject } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import { bear, copies, forest, gameConfig, oracle, pick, pump, spawn } from './fixtures';

interface PinnedFixture {
  schemaVersion: number;
  source: string;
  retrievedAt: string;
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/living-energy-engine-batch4-oracle.json'),
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

function activate(ctx: GameContext, objectId: string) {
  return computePriorityOptions(ctx, playerOf(ctx, 'P1')).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'activateAbility' && payload.objectId === objectId;
  });
}

describe('Living Energy engine-evidence batch 4 (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-11',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Aetherflux Conduit',
      "Bootleggers' Stash",
      'Combustible Gearhulk',
      'Panharmonicon',
      'Midnight Clock',
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

describe('Aetherflux Conduit', () => {
  const card = pinned('Aetherflux Conduit');

  it('conduit-gains-energy-equal-to-mana-spent-when-you-cast', () => {
    const ctx = pod('conduit-cast');
    const conduit = spawn(ctx, 'P1', card);
    pump(
      executeAbility(ctx, conduit, interpretCard(card).triggers[0]!, [], undefined, {
        manaSpent: 4,
      }),
    );
    expect(playerOf(ctx, 'P1').energy).toBe(4);
  });

  it('conduit-pays-fifty-energy-to-draw-seven-and-cannot-on-forty-nine', () => {
    const ctx = pod('conduit-pay');
    const conduit = spawn(ctx, 'P1', card);
    playerOf(ctx, 'P1').energy = 49;
    expect(activate(ctx, conduit.id)).toBeUndefined();
    playerOf(ctx, 'P1').energy = 50;
    const before = playerOf(ctx, 'P1').hand.length;
    pump(
      applyPriorityAction(
        ctx,
        playerOf(ctx, 'P1'),
        activate(ctx, conduit.id)!.payload as PriorityActionPayload,
        {
          index: 0,
          targets: new Map(),
        },
      ),
      (decision) => pick(decision, /Pass|Don't|Decline|done|Finish/i),
    );
    pump(resolveTopOfStack(ctx), (decision) => pick(decision, /Pass|Don't|Decline|done|Finish/i));
    expect(playerOf(ctx, 'P1').hand.length).toBe(before + 7);
    expect(playerOf(ctx, 'P1').energy).toBe(0);
  });
});

describe("Bootleggers' Stash", () => {
  const card = pinned("Bootleggers' Stash");

  it('stash-gives-your-lands-a-tap-for-treasure-and-is-not-itself-a-land', () => {
    const ctx = pod('stash-treasure');
    const stash = spawn(ctx, 'P1', card);
    const land = spawn(ctx, 'P1', forest());
    const treasureTap = computePriorityOptions(ctx, playerOf(ctx, 'P1')).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return (
        payload.kind === 'activateAbility' &&
        payload.objectId === land.id &&
        option.description.toLowerCase().includes('treasure')
      );
    });
    expect(treasureTap).toBeDefined();
    pump(
      applyPriorityAction(ctx, playerOf(ctx, 'P1'), treasureTap!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.battlefield.some((permanent) => permanent.name === 'Treasure')).toBe(true);

    expect(
      computePriorityOptions(ctx, playerOf(ctx, 'P1')).some((option) => {
        const payload = option.payload as PriorityActionPayload;
        return (
          payload.kind === 'activateAbility' &&
          payload.objectId === stash.id &&
          option.description.toLowerCase().includes('treasure')
        );
      }),
    ).toBe(false);
  });
});

describe('Combustible Gearhulk', () => {
  const card = pinned('Combustible Gearhulk');

  it('gearhulk-lets-an-opponent-draw-or-mill-and-cannot-target-you', () => {
    const ctx = pod('gearhulk-draw');
    const hulks = spawn(ctx, 'P1', card);
    const slot = interpretCard(card).triggers[0]!.targets[0]!;
    const legal = computeTargetOptions(ctx, slot, 'P1');
    expect(legal).toContain('P2');
    expect(legal).not.toContain('P1');
    const before = playerOf(ctx, 'P1').hand.length;
    pump(executeAbility(ctx, hulks, interpretCard(card).triggers[0]!, ['P2']), (decision) =>
      pick(decision, /draw three/),
    );
    expect(playerOf(ctx, 'P1').hand.length).toBe(before + 3);
  });
});

describe('Panharmonicon', () => {
  const card = pinned('Panharmonicon');

  it('panharmonicon-copies-your-creature-etb-not-an-enchantment-etb', () => {
    const ctx = pod('pan-etb');
    spawn(ctx, 'P1', card);
    const decoction = spawn(
      ctx,
      'P1',
      oracle({
        oracleId: '1daba4f6-2a7d-426a-97d1-0298a7100c45',
        name: 'Decoction Module',
        typeLine: 'Artifact',
        manaCost: '{2}',
        oracleText: 'Whenever a creature you control enters, you get {E}.',
      }),
    );
    const friend = spawn(ctx, 'P1', bear());
    queueTriggersForObject(ctx, 'enters', friend);
    expect(ctx.state.pendingTriggers).toHaveLength(2);
    for (const trigger of [...ctx.state.pendingTriggers]) {
      pump(executeAbility(ctx, decoction, trigger.ability, []));
    }
    expect(playerOf(ctx, 'P1').energy).toBe(2);

    const hex = pod('pan-hex');
    spawn(hex, 'P1', card);
    spawn(
      hex,
      'P1',
      oracle({
        oracleId: '1daba4f6-2a7d-426a-97d1-0298a7100c45',
        name: 'Decoction Module',
        typeLine: 'Artifact',
        manaCost: '{2}',
        oracleText: 'Whenever a creature you control enters, you get {E}.',
      }),
    );
    const charm = spawn(
      hex,
      'P1',
      oracle({ name: 'Pan Hex', typeLine: 'Enchantment', power: null, toughness: null }),
    );
    queueTriggersForObject(hex, 'enters', charm);
    expect(hex.state.pendingTriggers).toHaveLength(0);
  });
});

describe('Midnight Clock', () => {
  const card = pinned('Midnight Clock');

  it('clock-shuffles-draws-and-exiles-when-the-twelfth-hour-is-placed', () => {
    const ctx = pod('clock-twelve');
    const clock = spawn(ctx, 'P1', card);
    clock.counters['hour'] = 11;
    pump(
      executeAbility(
        ctx,
        clock,
        {
          kind: 'activated',
          targets: [],
          effects: [{ op: 'putCounters', target: 'source', counter: 'hour', count: 1 }],
        },
        [],
      ),
    );
    expect(clock.counters['hour']).toBe(12);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    const before = playerOf(ctx, 'P1').hand.length;
    pump(executeAbility(ctx, clock, ctx.state.pendingTriggers[0]!.ability, []));
    expect(playerOf(ctx, 'P1').hand.length).toBe(before + 7);
    expect(ctx.state.battlefield).not.toContain(clock);
    expect(ctx.state.exile.some((object) => object.cardId === clock.cardId)).toBe(true);

    const eleven = pod('clock-eleven');
    const early = spawn(eleven, 'P1', card);
    early.counters['hour'] = 10;
    pump(
      executeAbility(
        eleven,
        early,
        {
          kind: 'activated',
          targets: [],
          effects: [{ op: 'putCounters', target: 'source', counter: 'hour', count: 1 }],
        },
        [],
      ),
    );
    expect(eleven.state.pendingTriggers).toHaveLength(0);
  });
});
