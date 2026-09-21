import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { not, IS_COMMANDER } from '../src/cards/selector';
import { computeCharacteristics } from '../src/effects/continuous';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { queueCastTriggers, queueTriggersForEvent } from '../src/state/objects';
import { wardCostOf } from '../src/state/queries';
import type { GameContext } from '../src/state/types';
import { computeTargetOptions } from '../src/actions/legal';
import {
  bear,
  commanderFor,
  conjure,
  copies,
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
  readFileSync(join(import.meta.dirname, 'fixtures/urdragon-engine-batch1-oracle.json'), 'utf8'),
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

function resolvePending(ctx: GameContext, targets: string[] = []): void {
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
  );
}

describe('Ur-Dragon engine-evidence batch 1 (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-11',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Iymrith, Desert Doom',
      "Lozhan, Dragons' Legacy",
      'Thrakkus the Butcher',
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

describe('Iymrith, Desert Doom', () => {
  const card = pinned('Iymrith, Desert Doom');

  it('iymrith-has-ward-four-only-while-untapped', () => {
    const ctx = pod('iymrith-ward');
    const dragon = spawn(ctx, 'P1', card);
    expect(wardCostOf(ctx, dragon)?.kind).toBe('mana');
    dragon.tapped = true;
    expect(wardCostOf(ctx, dragon)).toBeNull();
  });

  it('iymrith-combat-damage-draws-then-fills-to-three', () => {
    const ctx = pod('iymrith-draw');
    const dragon = spawn(ctx, 'P1', card);
    const hand = playerOf(ctx, 'P1').hand.length;
    queueTriggersForEvent(ctx, 'dealsCombatDamageToPlayer', [{ permanent: dragon, amount: 5 }]);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    resolvePending(ctx);
    expect(playerOf(ctx, 'P1').hand.length).toBe(Math.max(hand + 1, 3));
  });

  it('iymrith-does-not-fill-when-hand-already-has-three-after-the-draw', () => {
    const ctx = pod('iymrith-full');
    const dragon = spawn(ctx, 'P1', card);
    conjure(ctx, 'P1', forest(), 'hand');
    conjure(ctx, 'P1', forest(), 'hand');
    conjure(ctx, 'P1', forest(), 'hand');
    const hand = playerOf(ctx, 'P1').hand.length;
    queueTriggersForEvent(ctx, 'dealsCombatDamageToPlayer', [{ permanent: dragon, amount: 5 }]);
    resolvePending(ctx);
    expect(playerOf(ctx, 'P1').hand.length).toBe(hand + 1);
  });
});

describe("Lozhan, Dragons' Legacy", () => {
  const card = pinned("Lozhan, Dragons' Legacy");

  it('lozhan-dragon-spell-damages-a-noncommander-equal-to-mana-value', () => {
    const ctx = pod('lozhan-dragon');
    spawn(ctx, 'P1', card);
    const dragonSpell = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Test Dragon',
        typeLine: 'Creature — Dragon',
        manaCost: '{3}{R}',
        cmc: 4,
        power: '4',
        toughness: '4',
      }),
      'hand',
    );
    const life = playerOf(ctx, 'P2').life;
    queueCastTriggers(ctx, {
      id: 'spell',
      kind: 'spell',
      controllerId: 'P1',
      sourceId: dragonSpell.id,
      sourceCardId: dragonSpell.cardId,
      sourceOracleId: dragonSpell.oracleId,
      description: dragonSpell.name,
      card: dragonSpell,
      ability: null,
      targets: [],
      isCommanderCast: false,
    });
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    resolvePending(ctx, ['P2']);
    expect(playerOf(ctx, 'P2').life).toBe(life - 4);
  });

  it('lozhan-does-not-fire-for-a-non-dragon-non-adventure-and-cannot-target-a-commander', () => {
    const ctx = pod('lozhan-miss');
    spawn(ctx, 'P1', card);
    const bearSpell = conjure(ctx, 'P1', bear(), 'hand');
    queueCastTriggers(ctx, {
      id: 'spell',
      kind: 'spell',
      controllerId: 'P1',
      sourceId: bearSpell.id,
      sourceCardId: bearSpell.cardId,
      sourceOracleId: bearSpell.oracleId,
      description: bearSpell.name,
      card: bearSpell,
      ability: null,
      targets: [],
      isCommanderCast: false,
    });
    expect(ctx.state.pendingTriggers).toHaveLength(0);

    const commander = spawn(ctx, 'P2', commanderFor('R', 'Enemy Hero'), { isCommander: true });
    const victim = spawn(ctx, 'P2', bear());
    const legal = computeTargetOptions(ctx, { kind: 'anyTarget', filter: not(IS_COMMANDER) }, 'P1');
    expect(legal).toContain(victim.id);
    expect(legal).not.toContain(commander.id);
  });
});

describe('Thrakkus the Butcher', () => {
  const card = pinned('Thrakkus the Butcher');

  it('thrakkus-attack-doubles-your-dragons-including-self', () => {
    const ctx = pod('thrakkus-dragons');
    const butcher = spawn(ctx, 'P1', card);
    const ally = spawn(
      ctx,
      'P1',
      oracle({ name: 'Ally Dragon', typeLine: 'Creature — Dragon', power: '3', toughness: '3' }),
    );
    const other = spawn(ctx, 'P1', bear());
    const enemy = spawn(
      ctx,
      'P2',
      oracle({ name: 'Enemy Dragon', typeLine: 'Creature — Dragon', power: '3', toughness: '3' }),
    );
    butcher.attacking = 'P2';
    queueTriggersForEvent(ctx, 'attacks', [{ permanent: butcher, playerId: 'P2' }]);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    resolvePending(ctx);
    expect(computeCharacteristics(ctx, butcher).power).toBe(6);
    expect(computeCharacteristics(ctx, ally).power).toBe(6);
    expect(computeCharacteristics(ctx, other).power).toBe(2);
    expect(computeCharacteristics(ctx, enemy).power).toBe(3);
  });

  it('thrakkus-does-not-trigger-for-another-attacker', () => {
    const ctx = pod('thrakkus-other');
    spawn(ctx, 'P1', card);
    const other = spawn(ctx, 'P1', bear());
    other.attacking = 'P2';
    queueTriggersForEvent(ctx, 'attacks', [{ permanent: other, playerId: 'P2' }]);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });
});
