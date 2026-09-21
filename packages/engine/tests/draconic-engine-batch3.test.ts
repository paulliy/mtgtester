import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { computeCharacteristics } from '../src/effects/continuous';
import { executeAbility } from '../src/effects/resolve';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { queueTriggersForEvent } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { bear, conjure, copies, forest, gameConfig, oracle, pick, pump, spawn } from './fixtures';

interface PinnedFixture {
  schemaVersion: number;
  source: string;
  retrievedAt: string;
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/draconic-engine-batch3-oracle.json'), 'utf8'),
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

describe('Draconic engine-evidence batch 3 (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-11',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Runehorn Hellkite',
      'Spit Flame',
      'Steel Hellkite',
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

describe('Runehorn Hellkite', () => {
  const card = pinned('Runehorn Hellkite');

  it('runehorn-graveyard-exile-makes-each-player-discard-then-draw-seven', () => {
    const ctx = pod('runehorn-yes');
    const hellkite = conjure(ctx, 'P1', card, 'graveyard');
    conjure(ctx, 'P1', forest(), 'hand');
    const before1 = playerOf(ctx, 'P1').library.length;
    const before2 = playerOf(ctx, 'P2').library.length;
    const def = interpretCard(card);
    expect(def.activatedAbilities[0]!.zone).toBe('graveyard');
    pump(
      executeAbility(ctx, sourceOf(card, hellkite.cardId), def.activatedAbilities[0]!.ability, []),
    );
    expect(playerOf(ctx, 'P1').hand.length).toBe(7);
    expect(playerOf(ctx, 'P2').hand.length).toBe(7);
    expect(playerOf(ctx, 'P1').library.length).toBe(before1 - 7);
    expect(playerOf(ctx, 'P2').library.length).toBe(before2 - 7);
  });

  it('runehorn-battlefield-copy-does-not-offer-the-graveyard-ability-as-a-field-activation', () => {
    const ctx = pod('runehorn-field');
    spawn(ctx, 'P1', card);
    const def = interpretCard(card);
    expect(def.activatedAbilities[0]!.zone).toBe('graveyard');
    expect(def.activatedAbilities).toHaveLength(1);
  });
});

describe('Spit Flame', () => {
  const card = pinned('Spit Flame');

  it('spit-deals-four-to-target-creature', () => {
    const ctx = pod('spit-damage');
    const victim = spawn(ctx, 'P2', bear());
    const other = spawn(ctx, 'P2', bear());
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, [victim.id]));
    expect(victim.damageMarked).toBe(4);
    expect(other.damageMarked).toBe(0);
  });

  it('spit-does-not-damage-an-untargeted-creature', () => {
    const ctx = pod('spit-miss-damage');
    const victim = spawn(ctx, 'P2', bear());
    expect(interpretCard(card).spellAbility).not.toBeNull();
    expect(victim.damageMarked).toBe(0);
  });

  it('spit-may-pay-red-to-return-when-your-dragon-enters', () => {
    const ctx = pod('spit-yes');
    const spit = conjure(ctx, 'P1', card, 'graveyard');
    addMana(playerOf(ctx, 'P1'), [{ symbol: 'R' }]);
    const dragon = spawn(
      ctx,
      'P1',
      oracle({ name: 'Test Dragon', typeLine: 'Creature — Dragon', power: '4', toughness: '4' }),
    );
    queueTriggersForEvent(ctx, 'enters', [{ permanent: dragon }]);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    const pending = ctx.state.pendingTriggers.shift()!;
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
      (decision) => pick(decision, 'Pay {R}'),
    );
    expect(playerOf(ctx, 'P1').hand.some((object) => object.cardId === spit.cardId)).toBe(true);
    expect(playerOf(ctx, 'P1').graveyard.some((object) => object.cardId === spit.cardId)).toBe(
      false,
    );
  });

  it('spit-does-not-trigger-for-an-opponent-dragon-or-a-non-dragon', () => {
    const ctx = pod('spit-miss');
    conjure(ctx, 'P1', card, 'graveyard');
    const theirs = spawn(
      ctx,
      'P2',
      oracle({ name: 'Enemy Dragon', typeLine: 'Creature — Dragon', power: '4', toughness: '4' }),
    );
    queueTriggersForEvent(ctx, 'enters', [{ permanent: theirs }]);
    expect(ctx.state.pendingTriggers).toHaveLength(0);

    const bearPerm = spawn(ctx, 'P1', bear());
    queueTriggersForEvent(ctx, 'enters', [{ permanent: bearPerm }]);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });
});

describe('Steel Hellkite', () => {
  const card = pinned('Steel Hellkite');

  it('hellkite-destroys-mv-x-permanents-of-players-it-damaged', () => {
    const ctx = pod('hellkite-yes');
    const hellkite = spawn(ctx, 'P1', card);
    const three = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Three Drop',
        typeLine: 'Creature — Bear',
        manaCost: '{2}{G}',
        cmc: 3,
        power: '2',
        toughness: '2',
      }),
    );
    const two = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Two Drop',
        typeLine: 'Creature — Bear',
        manaCost: '{1}{G}',
        cmc: 2,
        power: '2',
        toughness: '2',
      }),
    );
    ctx.state.combatDamagePlayersBySource[hellkite.cardId] = ['P2'];
    pump(
      executeAbility(
        ctx,
        sourceOf(card, hellkite.cardId),
        interpretCard(card).activatedAbilities[1]!.ability,
        [],
        undefined,
        { x: 3 },
      ),
    );
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === three.cardId)).toBe(
      false,
    );
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === two.cardId)).toBe(true);
  });

  it('hellkite-does-not-destroy-permanents-of-an-undamaged-player', () => {
    const ctx = pod('hellkite-miss');
    const hellkite = spawn(ctx, 'P1', card);
    const victim = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Three Drop',
        typeLine: 'Creature — Bear',
        manaCost: '{2}{G}',
        cmc: 3,
        power: '2',
        toughness: '2',
      }),
    );
    pump(
      executeAbility(
        ctx,
        sourceOf(card, hellkite.cardId),
        interpretCard(card).activatedAbilities[1]!.ability,
        [],
        undefined,
        { x: 3 },
      ),
    );
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === victim.cardId)).toBe(
      true,
    );
    expect(computeCharacteristics(ctx, hellkite).power).toBe(5);
  });

  it('hellkite-plus-one-power-until-eot', () => {
    const ctx = pod('hellkite-pump');
    const hellkite = spawn(ctx, 'P1', card);
    pump(
      executeAbility(
        ctx,
        sourceOf(card, hellkite.cardId),
        interpretCard(card).activatedAbilities[0]!.ability,
        [],
      ),
    );
    expect(computeCharacteristics(ctx, hellkite).power).toBe(6);
    expect(computeCharacteristics(ctx, hellkite).toughness).toBe(5);
  });
});
