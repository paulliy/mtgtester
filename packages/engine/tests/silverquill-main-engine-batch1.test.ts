import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import {
  computePriorityOptions,
  costReductionFor,
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
import {
  bear,
  conjure,
  copies,
  forest,
  gameConfig,
  oracle,
  pick,
  plains,
  pump,
  registerDef,
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
    join(import.meta.dirname, 'fixtures/silverquill-main-engine-batch1-oracle.json'),
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

function sourceOf(card: OracleCard, cardId: string) {
  return { cardId, name: card.name, oracleId: card.oracleId, controllerId: 'P1' as const };
}

const labAura = (): OracleCard =>
  oracle({
    name: 'Lab Aura',
    typeLine: 'Enchantment — Aura',
    manaCost: '{2}{W}',
    oracleText: 'Enchant creature\nEnchanted creature gets +1/+1.',
  });

const labEnchantment = (): OracleCard =>
  oracle({
    name: 'Lab Enchantment',
    typeLine: 'Enchantment',
    manaCost: '{2}{W}',
    oracleText: 'At the beginning of your upkeep, you gain 1 life.',
  });

describe('Silverquill main engine-evidence batch 1 (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-11',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Transcendent Envoy',
      'Flickering Ward',
      'Bojuka Bog',
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

describe('Transcendent Envoy', () => {
  const card = pinned('Transcendent Envoy');

  it('envoy-reduces-aura-spells-not-other-enchantments-or-creatures', () => {
    const ctx = pod('envoy-reduce');
    spawn(ctx, 'P1', card);
    registerDef(ctx, labAura());
    registerDef(ctx, labEnchantment());
    registerDef(ctx, bear());
    expect(costReductionFor(ctx, 'P1', labAura().oracleId, 'c-aura').generic).toBe(1);
    expect(costReductionFor(ctx, 'P1', labEnchantment().oracleId, 'c-enchant').generic).toBe(0);
    expect(costReductionFor(ctx, 'P1', bear().oracleId, 'c-bear').generic).toBe(0);
  });

  it('envoy-does-not-reduce-for-an-opponent', () => {
    const ctx = pod('envoy-opp');
    spawn(ctx, 'P2', card);
    registerDef(ctx, labAura());
    expect(costReductionFor(ctx, 'P1', labAura().oracleId, 'c-aura').generic).toBe(0);
  });
});

describe('Flickering Ward', () => {
  const card = pinned('Flickering Ward');

  it('ward-chosen-color-protects-only-the-enchanted-creature', () => {
    const ctx = pod('ward-protect');
    const host = spawn(ctx, 'P1', bear());
    const other = spawn(ctx, 'P1', bear());
    const auraObj = conjure(ctx, 'P1', card, 'hand');
    pump(moveObject(ctx, auraObj, { zone: 'battlefield', attachedTo: host.id }), (decision) =>
      pick(decision, 'Red'),
    );
    const aura = ctx.state.battlefield.find((permanent) => permanent.cardId === auraObj.cardId)!;
    aura.attachedTo = host.id;
    expect(aura.chosenOption).toBe('R');
    expect(computeCharacteristics(ctx, host).protectionFrom).toEqual(['R']);
    expect(computeCharacteristics(ctx, other).protectionFrom).toEqual([]);
  });

  it('ward-bounce-returns-to-hand-and-drops-protection', () => {
    const ctx = pod('ward-bounce');
    spawn(ctx, 'P1', plains());
    const host = spawn(ctx, 'P1', bear());
    const auraObj = conjure(ctx, 'P1', card, 'hand');
    pump(moveObject(ctx, auraObj, { zone: 'battlefield', attachedTo: host.id }), (decision) =>
      pick(decision, 'Blue'),
    );
    const aura = ctx.state.battlefield.find((permanent) => permanent.cardId === auraObj.cardId)!;
    aura.attachedTo = host.id;
    const activate = computePriorityOptions(ctx, playerOf(ctx, 'P1')).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && option.description.includes('Flickering Ward');
    });
    expect(activate).toBeDefined();
    pump(
      applyPriorityAction(ctx, playerOf(ctx, 'P1'), activate!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === auraObj.cardId)).toBe(
      false,
    );
    expect(playerOf(ctx, 'P1').hand.some((object) => object.cardId === auraObj.cardId)).toBe(true);
    expect(computeCharacteristics(ctx, host).protectionFrom).toEqual([]);
  });
});

describe('Bojuka Bog', () => {
  const card = pinned('Bojuka Bog');

  it('bog-enters-tapped-and-exiles-the-targeted-graveyard', () => {
    const ctx = pod('bog-exile');
    const dead = conjure(ctx, 'P2', bear(), 'graveyard');
    const yours = conjure(ctx, 'P1', bear(), 'graveyard');
    const land = conjure(ctx, 'P1', card, 'hand');
    pump(moveObject(ctx, land, { zone: 'battlefield' }));
    const perm = ctx.state.battlefield.find((permanent) => permanent.cardId === land.cardId);
    expect(perm?.tapped).toBe(true);
    const trigger = interpretCard(card).triggers[0]!;
    pump(executeAbility(ctx, sourceOf(card, land.cardId), trigger, ['P2']));
    expect(ctx.state.exile.some((object) => object.cardId === dead.cardId)).toBe(true);
    expect(playerOf(ctx, 'P2').graveyard).toHaveLength(0);
    expect(playerOf(ctx, 'P1').graveyard.some((object) => object.cardId === yours.cardId)).toBe(
      true,
    );
  });

  it('bog-does-not-exile-an-untargeted-graveyard', () => {
    const ctx = pod('bog-other');
    const dead = conjure(ctx, 'P2', bear(), 'graveyard');
    const land = conjure(ctx, 'P1', card, 'hand');
    pump(moveObject(ctx, land, { zone: 'battlefield' }));
    const trigger = interpretCard(card).triggers[0]!;
    pump(executeAbility(ctx, sourceOf(card, land.cardId), trigger, ['P1']));
    expect(playerOf(ctx, 'P2').graveyard.some((object) => object.cardId === dead.cardId)).toBe(
      true,
    );
  });

  it('bog-normal-play-from-hand', () => {
    const ctx = pod('bog-play');
    conjure(ctx, 'P2', bear(), 'graveyard');
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
    );
    const perm = ctx.state.battlefield.find((permanent) => permanent.cardId === land.cardId);
    expect(perm?.tapped).toBe(true);
    const trigger = interpretCard(card).triggers[0]!;
    pump(executeAbility(ctx, sourceOf(card, land.cardId), trigger, ['P2']));
    expect(playerOf(ctx, 'P2').graveyard).toHaveLength(0);
  });
});
