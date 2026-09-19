import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { computeCharacteristics } from '../src/effects/continuous';
import { executeAbility } from '../src/effects/resolve';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { queueTriggersForObject } from '../src/state/objects';
import { hasNoMaximumHandSize, manaSourcesFor } from '../src/state/queries';
import type { GameContext } from '../src/state/types';
import { bear, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

interface PinnedFixture {
  schemaVersion: number;
  source: string;
  retrievedAt: string;
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/necron-main-engine-batch2-oracle.json'), 'utf8'),
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

describe('Necron main engine-evidence batch 2 stubs (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-11',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Chronomancer',
      'Reliquary Tower',
      'Royal Warden',
      'Thought Vessel',
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

describe('Chronomancer', () => {
  const card = pinned('Chronomancer');

  it('chrono-flies-and-sacs-another-artifact-to-draw-not-itself', () => {
    const ctx = pod('chrono-draw');
    const chrono = spawn(ctx, 'P1', card);
    expect(computeCharacteristics(ctx, chrono).keywords).toContain('flying');
    expect(
      interpretCard(card).activatedAbilities.some(
        (ability) => ability.zone === 'graveyard' && ability.timing === 'sorcery',
      ),
    ).toBe(true);

    const lonely = pod('chrono-lonely');
    const only = spawn(lonely, 'P1', card);
    addMana(playerOf(lonely, 'P1'), [{ symbol: 'C' }]);
    expect(activate(lonely, only.id)).toBeUndefined();

    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Chrono Cog',
        typeLine: 'Artifact',
        manaCost: '{1}',
        power: null,
        toughness: null,
      }),
    );
    const transmutation = interpretCard(card).activatedAbilities.find(
      (ability) => ability.zone !== 'graveyard',
    )!;
    const before = playerOf(ctx, 'P1').hand.length;
    pump(executeAbility(ctx, chrono, transmutation.ability, []));
    expect(playerOf(ctx, 'P1').hand.length).toBe(before + 1);
  });
});

describe('Reliquary Tower', () => {
  const card = pinned('Reliquary Tower');

  it('tower-removes-your-hand-size-not-theirs-and-taps-for-colorless', () => {
    const ctx = pod('tower-hand');
    const tower = spawn(ctx, 'P1', card);
    expect(hasNoMaximumHandSize(ctx, 'P1')).toBe(true);
    expect(hasNoMaximumHandSize(ctx, 'P2')).toBe(false);
    const source = manaSourcesFor(ctx, 'P1').find((candidate) => candidate.cardId === tower.cardId);
    expect(source?.units).toEqual([['C']]);

    const theirs = pod('tower-theirs');
    spawn(theirs, 'P2', card);
    expect(hasNoMaximumHandSize(theirs, 'P1')).toBe(false);
    expect(hasNoMaximumHandSize(theirs, 'P2')).toBe(true);
  });
});

describe('Royal Warden', () => {
  const card = pinned('Royal Warden');

  it('warden-etb-makes-two-tapped-warriors-and-unearths-from-the-graveyard', () => {
    const ctx = pod('warden-etb');
    const warden = spawn(ctx, 'P1', card);
    pump(executeAbility(ctx, warden, interpretCard(card).triggers[0]!, []));
    const warriors = ctx.state.battlefield.filter(
      (permanent) => permanent.name === 'Necron Warrior',
    );
    expect(warriors).toHaveLength(2);
    expect(warriors.every((token) => token.tapped)).toBe(true);

    const other = pod('warden-other');
    spawn(other, 'P1', card);
    const friend = spawn(other, 'P1', bear());
    queueTriggersForObject(other, 'enters', friend);
    expect(other.state.pendingTriggers).toHaveLength(0);

    expect(
      interpretCard(card).activatedAbilities.some(
        (ability) => ability.zone === 'graveyard' && ability.timing === 'sorcery',
      ),
    ).toBe(true);
  });
});

describe('Thought Vessel', () => {
  const card = pinned('Thought Vessel');

  it('vessel-removes-your-hand-size-not-theirs-and-taps-for-colorless', () => {
    const ctx = pod('vessel-hand');
    const vessel = spawn(ctx, 'P1', card);
    expect(hasNoMaximumHandSize(ctx, 'P1')).toBe(true);
    expect(hasNoMaximumHandSize(ctx, 'P2')).toBe(false);
    const source = manaSourcesFor(ctx, 'P1').find(
      (candidate) => candidate.cardId === vessel.cardId,
    );
    expect(source?.units).toEqual([['C']]);

    const none = pod('vessel-none');
    expect(hasNoMaximumHandSize(none, 'P1')).toBe(false);
  });
});
