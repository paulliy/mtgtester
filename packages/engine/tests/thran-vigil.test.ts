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
import { moveObject, moveObjects } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { runTurn } from '../src/turn/turn';
import { conjure, copies, forest, gameConfig, oracle, pump, pumpStrict, spawn } from './fixtures';

interface PinnedFixture {
  cards: { card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/reviewed-five-oracle.json'), 'utf8'),
) as PinnedFixture;
const thran = fixture.cards.find(({ card }) => card.name === 'Thran Vigil')!.card;

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

function artifact(name: string): OracleCard {
  return oracle({ name, typeLine: 'Artifact', manaCost: '{1}' });
}

function creature(name: string): OracleCard {
  return oracle({
    name,
    typeLine: 'Creature — Bear',
    manaCost: '{1}{G}',
    power: '2',
    toughness: '2',
  });
}

describe('Thran Vigil', () => {
  it('models the complete pinned Oracle text for real and fixture IDs', () => {
    for (const card of [thran, { ...thran, oracleId: fixtureOracleId(thran.name) }]) {
      const def = interpretCard(card);
      expect(def.modeled, card.oracleId).toBe(true);
      expect(def.unmodeledReasons, card.oracleId).toEqual([]);
      expect(def.triggers[0]?.trigger).toMatchObject({
        when: 'leavesGraveyard',
        aggregate: true,
        condition: { kind: 'yourTurn' },
      });
      expect(def.triggers[0]?.targets).toEqual([{ kind: 'creature', controller: 'you' }]);
    }
  });

  it('thran-vigil-own-turn-aggregate — fires once when multiple qualifying own cards leave together', () => {
    const ctx = pod('thran-aggregate');
    spawn(ctx, 'P1', thran);
    const relic = conjure(ctx, 'P1', artifact('Relic'), 'graveyard');
    const bear = conjure(ctx, 'P1', creature('Bear'), 'graveyard');

    pump(moveObjects(ctx, [relic, bear], { zone: 'exile' }));

    expect(ctx.state.pendingTriggers).toHaveLength(1);
    expect(ctx.state.pendingTriggers[0]?.scope).toMatchObject({ triggerCount: 2 });
  });

  it('thran-separate-events-separate-triggers — treats separate departures as separate events', () => {
    const ctx = pod('thran-separate');
    spawn(ctx, 'P1', thran);
    const first = conjure(ctx, 'P1', artifact('First Relic'), 'graveyard');
    const second = conjure(ctx, 'P1', creature('Second Bear'), 'graveyard');

    pump(moveObject(ctx, first, { zone: 'exile' }));
    pump(moveObject(ctx, second, { zone: 'hand' }));

    expect(ctx.state.pendingTriggers).toHaveLength(2);
  });

  it('thran-single-and-entry — fires once for one qualifying departure but not battlefield entry from hand', () => {
    const ctx = pod('thran-single-and-entry');
    spawn(ctx, 'P1', thran);
    const entering = conjure(ctx, 'P1', creature('Entering Bear'), 'hand');
    pump(moveObject(ctx, entering, { zone: 'battlefield' }));
    expect(ctx.state.pendingTriggers).toHaveLength(0);

    const relic = conjure(ctx, 'P1', artifact('Single Relic'), 'graveyard');
    pump(moveObject(ctx, relic, { zone: 'hand' }));
    expect(ctx.state.pendingTriggers).toHaveLength(1);
  });

  it('thran-event-restrictions — rejects wrong types, owners, and turns', () => {
    const ctx = pod('thran-restrictions');
    spawn(ctx, 'P1', thran);
    const ownSorcery = conjure(
      ctx,
      'P1',
      oracle({ name: 'Own Sorcery', typeLine: 'Sorcery', manaCost: '{1}{B}' }),
      'graveyard',
    );
    const opponentArtifact = conjure(ctx, 'P2', artifact('Opponent Relic'), 'graveyard');
    pump(moveObjects(ctx, [ownSorcery, opponentArtifact], { zone: 'exile' }));
    expect(ctx.state.pendingTriggers).toHaveLength(0);

    const ownArtifact = conjure(ctx, 'P1', artifact('Late Relic'), 'graveyard');
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    pump(moveObject(ctx, ownArtifact, { zone: 'hand' }));
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });

  it('thran-mandatory-own-creature — puts exactly one counter on its mandatory own target', () => {
    const ctx = pod('thran-counter');
    const vigil = spawn(ctx, 'P1', thran);
    const chosen = spawn(ctx, 'P1', creature('Chosen Bear'));
    const opponent = spawn(ctx, 'P2', creature('Opponent Bear'));
    const ability = interpretCard(thran).triggers[0]!;

    pump(executeAbility(ctx, vigil, ability, [chosen.id]));
    expect(chosen.counters['+1/+1']).toBe(1);
    expect(opponent.counters['+1/+1'] ?? 0).toBe(0);

    // Through the real stack: the trigger is mandatory, so resolving it asks no "use it?" first.
    const relic = conjure(ctx, 'P1', artifact('Counter Relic'), 'graveyard');
    pump(moveObject(ctx, relic, { zone: 'exile' }));
    // The one creature it can target is forced, so no target question is raised.
    pumpStrict(priorityCheckpoint(ctx));
    expect(ctx.state.stack).toHaveLength(1);
    const { decisions } = pump(resolveTopOfStack(ctx));
    expect(decisions.map((decision) => decision.decisionType)).not.toContain('optionalTrigger');
    expect(chosen.counters['+1/+1']).toBe(2);
    expect(opponent.counters['+1/+1'] ?? 0).toBe(0);
  });

  it('thran-invalidated-target — fizzles when its chosen target leaves before resolution', () => {
    const ctx = pod('thran-invalidated-target');
    spawn(ctx, 'P1', thran);
    const chosen = spawn(ctx, 'P1', creature('Doomed Bear'));
    const opponent = spawn(ctx, 'P2', creature('Opponent Bear'));
    const relic = conjure(ctx, 'P1', artifact('Departing Relic'), 'graveyard');
    pumpStrict(moveObject(ctx, relic, { zone: 'exile' }));

    const gen = runTurn(ctx);
    let step = gen.next();
    while (step.done !== true) {
      if (step.value.decisionType === 'chooseTargets') {
        const option = step.value.options[0]!;
        expect(option.type).toBe('chooseTargets');
        if (option.type !== 'chooseTargets') throw new Error('expected target choice');
        expect(option.targets).toBeDefined();
        expect(option.targets![0]?.options).toContain(chosen.id);
        expect(option.targets![0]?.options).not.toContain(opponent.id);
        step = gen.next({ index: 0, targets: new Map([[0, chosen.id]]) });
        ctx.state.battlefield = ctx.state.battlefield.filter(
          (permanent) => permanent.id !== chosen.id,
        );
        continue;
      }
      step = gen.next({ index: 0, targets: new Map() });
    }

    expect(ctx.state.eventLog.some((event) => event.type === 'fizzle')).toBe(true);
  });

  it('thran-normal-cast — casts at sorcery speed and resolves as an enchantment', () => {
    const ctx = pod('thran-cast');
    const player = ctx.state.players[0]!;
    const spell = conjure(ctx, 'P1', thran, 'hand');
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', oracle({ name: 'Swamp', typeLine: 'Basic Land — Swamp' }));
    const isCast = (option: EngineActionOption): boolean => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === spell.id;
    };

    const cast = computePriorityOptions(ctx, player).find(isCast);
    expect(cast).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, cast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    pumpStrict(resolveTopOfStack(ctx));

    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === spell.cardId)).toBe(true);
  });
});
