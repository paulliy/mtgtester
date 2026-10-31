/**
 * Zone changes the zone-mutation lint found hand-rolled (ADR 0034 decision 7). Midnight Clock's
 * now goes through state/objects.ts: it skipped a commander's command-zone choice and never
 * shuffled the library it shuffled cards into. Etali's real effect already did; the dead op that
 * hand-rolled the same exile is gone, and this pins the commander case on the live one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import type { Ability } from '../src/cards/ability';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { priorityCheckpoint } from '../src/sba/sba';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import {
  commanderFor,
  conjure,
  copies,
  forest,
  gameConfig,
  oracle,
  pump,
  pumpStrict,
  spawn,
} from './fixtures';
import { pinStore } from './scenario/pin-store';

const midnightClock = (
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, 'fixtures/living-energy-engine-batch4-oracle.json'),
      'utf8',
    ),
  ) as { cards: Array<{ card: OracleCard }> }
).cards.find(({ card }) => card.name === 'Midnight Clock')!.card;
const etali = pinStore.get('Etali, Primal Conqueror // Etali, Primal Sickness');

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(10, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  return ctx;
}

/** A card the test can find again: a named sorcery. */
const named = (name: string) => oracle({ name, typeLine: 'Sorcery', manaCost: '{1}' });

describe('Midnight Clock shuffles hand and graveyard into the library', () => {
  const twelfthHour = (): Ability =>
    interpretCard(midnightClock).counterThresholdTriggers![0]!.ability;

  it('zone-mutation-clock-shuffles-the-library — the whole library, not only the cards it adds', () => {
    const ctx = pod('clock-whole-library');
    const p1 = ctx.state.players[0]!;
    p1.library.splice(0, p1.library.length);
    for (let index = 0; index < 20; index++)
      conjure(ctx, 'P1', named(`Library card ${index}`), 'library');
    const topSeven = p1.library.slice(0, 7).map((card) => card.name);
    conjure(ctx, 'P1', named('Hand card'), 'hand');
    conjure(ctx, 'P1', named('Graveyard card'), 'graveyard');
    const clock = spawn(ctx, 'P1', midnightClock);

    pumpStrict(executeAbility(ctx, clock, twelfthHour(), []));

    expect(ctx.state.eventLog.filter((event) => event.type === 'shuffle')).toHaveLength(1);
    // Seven drawn from a shuffled 22-card library are not the old top seven, in order.
    expect(p1.hand.map((card) => card.name)).not.toEqual(topSeven);
    expect(p1.hand).toHaveLength(7);
    expect(p1.graveyard).toHaveLength(0);
    expect(p1.library).toHaveLength(15);
  });

  it('zone-mutation-clock-commander-choice — a commander in hand may go to the command zone', () => {
    const ctx = pod('clock-commander');
    const general = conjure(ctx, 'P1', commanderFor('G', 'Clock General'), 'hand', {
      isCommander: true,
    });
    const clock = spawn(ctx, 'P1', midnightClock);
    const { decisions } = pump(
      executeAbility(ctx, clock, twelfthHour(), []),
      (decision) => ({
        index: decision.options.findIndex((option) => option.type === 'commanderToCommandZone'),
        targets: new Map(),
      }),
      { strict: true },
    );

    expect(decisions.map((decision) => decision.decisionType)).toContain('commanderReplacement');
    expect(ctx.state.players[0]!.commandZone.map((card) => card.name)).toContain(general.name);
  });
});

describe("Etali exiles from each library's top through moveObject", () => {
  it('zone-mutation-etali-commander-choice — an exiled commander may return to the command zone', () => {
    const ctx = pod('etali-commander');
    const p2 = ctx.state.players[1]!;
    const general = conjure(ctx, 'P2', commanderFor('R', 'Etali General'), 'library', {
      isCommander: true,
    });
    expect(p2.library[0]).toBe(general);
    const source = spawn(ctx, 'P1', etali);
    const trigger = interpretCard(etali).triggers.find((ability) =>
      ability.effects.some((effect) => effect.op === 'exileEachUntilNonlandCast'),
    )!;
    // Decline every free cast, then let state-based actions offer the commander its zone.
    pump(
      executeAbility(ctx, source, trigger, []),
      (decision) => ({
        index: decision.options.length - 1,
        targets: new Map(),
      }),
      { strict: true },
    );
    expect(ctx.state.exile.some((card) => card.name === general.name)).toBe(true);
    // The command-zone choice (CR 903.9a) is the only option, so it resolves as forced.
    pumpStrict(priorityCheckpoint(ctx));

    expect(p2.commandZone.map((card) => card.name)).toContain(general.name);
    expect(ctx.state.exile.some((card) => card.name === general.name)).toBe(false);
  });
});
