import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import type { EngineActionOption } from '../src/decisions';
import { executeAbility } from '../src/effects/resolve';
import { priorityCheckpoint } from '../src/sba/sba';
import { resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

interface PinnedFixture {
  cards: { card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/reviewed-five-oracle.json'), 'utf8'),
) as PinnedFixture;
const tribute = fixture.cards.find(({ card }) => card.name === 'Tribute Mage')!.card;

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(8, forest) })),
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

function searchCards(ctx: GameContext): void {
  conjure(
    ctx,
    'P1',
    oracle({
      name: 'Eligible Talisman',
      typeLine: 'Artifact',
      manaCost: '{2}',
    }),
    'library',
  );
  conjure(
    ctx,
    'P1',
    oracle({
      name: 'Eligible Signet',
      typeLine: 'Artifact',
      manaCost: '{1}{U}',
    }),
    'library',
  );
  conjure(
    ctx,
    'P1',
    oracle({ name: 'Too Cheap', typeLine: 'Artifact', manaCost: '{1}' }),
    'library',
  );
  conjure(
    ctx,
    'P1',
    oracle({ name: 'Too Expensive', typeLine: 'Artifact', manaCost: '{3}' }),
    'library',
  );
  conjure(
    ctx,
    'P1',
    oracle({ name: 'Two-Mana Bear', typeLine: 'Creature', manaCost: '{2}' }),
    'library',
  );
}

describe('Tribute Mage', () => {
  it('models the complete pinned Oracle text for real and fixture IDs', () => {
    for (const card of [tribute, { ...tribute, oracleId: fixtureOracleId(tribute.name) }]) {
      const def = interpretCard(card);
      expect(def.modeled, card.oracleId).toBe(true);
      expect(def.unmodeledReasons, card.oracleId).toEqual([]);
      expect(def.triggers).toHaveLength(1);
    }
  });

  it('tribute-eligible-artifact-mv2 — and rejection scenarios offer exactly artifacts with mana value 2', () => {
    const ctx = pod('tribute-filter');
    searchCards(ctx);
    const source = spawn(ctx, 'P1', tribute);
    const trigger = interpretCard(tribute).triggers![0]!;

    const { decisions } = pump(executeAbility(ctx, source, trigger, []), (decision) => {
      const descriptions = decision.options.map((option) => option.description);
      expect(descriptions).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Eligible Talisman'),
          expect.stringContaining('Eligible Signet'),
          'Find nothing',
        ]),
      );
      expect(descriptions.join('\n')).not.toMatch(/Too Cheap|Too Expensive|Two-Mana Bear/);
      return {
        index: descriptions.findIndex((description) => description.includes('Eligible Signet')),
        targets: new Map(),
      };
    });

    expect(decisions).toHaveLength(1);
    expect(ctx.state.players[0]!.hand.map((card) => card.name)).toContain('Eligible Signet');
    expect(ctx.state.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
  });

  it('tribute-decline-search — leaves eligible cards in the library and still shuffles', () => {
    const ctx = pod('tribute-decline');
    searchCards(ctx);
    const source = spawn(ctx, 'P1', tribute);
    const trigger = interpretCard(tribute).triggers![0]!;

    pump(executeAbility(ctx, source, trigger, []), (decision) => ({
      index: decision.options.findIndex((option) => option.type === 'findNothing'),
      targets: new Map(),
    }));

    expect(ctx.state.players[0]!.hand).toHaveLength(0);
    expect(
      ctx.state.players[0]!.library.filter((card) => card.name.startsWith('Eligible')),
    ).toHaveLength(2);
    expect(ctx.state.eventLog.filter((event) => event.type === 'shuffle')).toHaveLength(1);
  });

  it('tribute-no-eligible-card — presents no search choice and still shuffles', () => {
    const ctx = pod('tribute-no-match');
    conjure(
      ctx,
      'P1',
      oracle({ name: 'Wrong Relic', typeLine: 'Artifact', manaCost: '{4}' }),
      'library',
    );
    const source = spawn(ctx, 'P1', tribute);
    const trigger = interpretCard(tribute).triggers![0]!;
    const { decisions } = pump(executeAbility(ctx, source, trigger, []));

    expect(decisions).toEqual([]);
    expect(ctx.state.eventLog.filter((event) => event.type === 'shuffle')).toHaveLength(1);
  });

  it('tribute-normal-cast-etb — pays its mana cost, respects sorcery timing, and resolves the ETB search', () => {
    const ctx = pod('tribute-normal-cast');
    const player = ctx.state.players[0]!;
    const spell = conjure(ctx, 'P1', tribute, 'hand');
    searchCards(ctx);
    for (const land of [
      oracle({ name: 'Island', typeLine: 'Basic Land — Island' }),
      forest(),
      forest(),
    ]) {
      spawn(ctx, 'P1', land);
    }
    const isTributeCast = (option: EngineActionOption): boolean => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === spell.id;
    };

    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    expect(computePriorityOptions(ctx, player).some(isTributeCast)).toBe(false);
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;

    const cast = computePriorityOptions(ctx, player).find(isTributeCast);
    expect(cast).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, cast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(ctx.state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);

    pump(resolveTopOfStack(ctx));
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === spell.cardId)).toBe(true);
    pump(priorityCheckpoint(ctx), (decision) => ({
      index: decision.options.findIndex((option) =>
        option.description.includes('Eligible Talisman'),
      ),
      targets: new Map(),
    }));
    pump(resolveTopOfStack(ctx), (decision) => ({
      index: decision.options.findIndex((option) =>
        option.description.includes('Eligible Talisman'),
      ),
      targets: new Map(),
    }));
    expect(player.hand.map((card) => card.name)).toContain('Eligible Talisman');
  });
});
