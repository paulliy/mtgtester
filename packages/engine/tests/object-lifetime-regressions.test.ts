import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard, DecisionRequest } from '@mtg/shared';
import { Engine } from '../src/engine';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import { dealDamageToCreature, executeAbility } from '../src/effects/resolve';
import { computeCharacteristics } from '../src/effects/continuous';
import { priorityCheckpoint } from '../src/sba/sba';
import { applyPriorityAction } from '../src/actions/apply';
import type { PriorityActionPayload } from '../src/actions/legal';
import { computePriorityOptions } from '../src/actions/legal';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import {
  bear,
  conjure,
  copies,
  divination,
  forest,
  gameConfig,
  giantGrowth,
  island,
  oracle,
  plains,
  pump,
  spawn,
  swamp,
} from './fixtures';

const fixture = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/bug-hunt-oracle.json', 'utf8'),
) as { cards: { card: OracleCard }[] };
const real = (name: string) => {
  const card = fixture.cards.map((entry) => entry.card).find((card) => card.name === name);
  if (!card) throw new Error(`Missing Oracle fixture ${name}`);
  expect(interpretCard(card).modeled, name).toBe(true);
  return card;
};

function pod() {
  const ctx = createGame(gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(6, forest) }))));
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  return ctx;
}

function chooseFirst(request: DecisionRequest) {
  const action = request.legalActions[0]!;
  return {
    requestId: request.requestId,
    actionId: action.id,
    targets: action.targets?.map((slot) => ({ slot: slot.slot, choice: slot.options[0]! })) ?? [],
  };
}

describe('expected rules regressions', () => {
  it('a resolved pump must not affect the new object returned by Oji', () => {
    const growth = giantGrowth();
    const draw = divination();
    const oji = real('Oji, the Exquisite Blade');
    const engine = new Engine(
      gameConfig([
        { cards: [bear(), growth, draw, oji, forest(), island(), island(), ...copies(5, forest)] },
        { cards: copies(8, forest) },
      ]),
      {
        preparedScenario: {
          currentTurnPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: 4,
          hand: [{ playerId: 'P1', cardNames: [growth.name, draw.name] }],
          battlefield: [
            { playerId: 'P1', cardNames: ['Test Bear', oji.name, 'Forest', 'Island', 'Island'] },
          ],
        },
      },
    );
    const before = engine.view('P1').battlefield.find((p) => p.name === 'Test Bear')!;
    let stage = 0;
    for (let i = 0; i < 100; i++) {
      const step = engine.advance();
      if (step.kind === 'gameOver') break;
      if (step.kind !== 'decision') continue;
      const request = step.request;
      const name = stage === 0 ? growth.name : draw.name;
      const cast =
        request.decidingPlayer === 'P1' &&
        request.legalActions.find((a) => a.type === 'castSpell' && a.description.includes(name));
      if (stage < 2 && cast) {
        if (stage === 1)
          expect(engine.view('P1').battlefield.find((p) => p.id === before.id)?.power).toBe(5);
        engine.submit({
          requestId: request.requestId,
          actionId: cast.id,
          targets: cast.targets?.map((slot) => ({ slot: slot.slot, choice: before.id })) ?? [],
        });
        stage++;
      } else {
        const selectCount = request.legalActions.find(
          (a) => a.type === 'chooseTargetCount' && a.description.includes('1'),
        );
        const selectBear = request.legalActions.find(
          (a) => a.description.includes('Test Bear') && a.type !== 'castSpell',
        );
        if (request.decidingPlayer === 'P1' && selectCount)
          engine.submit({ requestId: request.requestId, actionId: selectCount.id });
        else if (request.decidingPlayer === 'P1' && selectBear)
          engine.submit({ requestId: request.requestId, actionId: selectBear.id });
        else engine.submit(chooseFirst(request));
      }
    }
    expect(stage).toBe(2);
    const after = engine.view('P1').battlefield.find((p) => p.name === 'Test Bear')!;
    expect(after.id).not.toBe(before.id);
    expect([after.power, after.toughness]).toEqual([2, 2]);
  });

  it('an old self-targeted activation must not modify its blinked replacement', () => {
    const ctx = pod();
    const ojiCard = real('Oji, the Exquisite Blade');
    const oji = spawn(ctx, 'P1', ojiCard);
    const chronoCard = oracle({
      name: 'Chronomaton',
      typeLine: 'Artifact Creature — Golem',
      power: '1',
      toughness: '1',
      oracleText: '{1}, {T}: Put a +1/+1 counter on this creature.',
    });
    expect(interpretCard(chronoCard).modeled).toBe(true);
    const chrono = spawn(ctx, 'P1', chronoCard);
    spawn(ctx, 'P1', forest());
    const player = ctx.state.players[0]!;
    const activation = computePriorityOptions(ctx, player).find(
      (option) => option.type === 'activateAbility' && option.description.includes(chrono.name),
    )!;
    expect(activation).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, activation.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(ctx.state.stack.at(-1)?.sourceId).toBe(chrono.id);
    // Oji's second-spell trigger can resolve above this activated ability.
    pump(
      executeAbility(ctx, oji, interpretCard(ojiCard).triggers.at(-1)!, [], undefined, undefined, {
        0: [chrono.id],
      }),
    );
    const returned = ctx.state.battlefield.find((p) => p.cardId === chrono.cardId)!;
    expect(returned.id).not.toBe(chrono.id);
    pump(resolveTopOfStack(ctx));
    expect(returned.counters['+1/+1'] ?? 0).toBe(0);
  });

  it('a reanimated opponent-owned creature must be exiled when its caster loses', () => {
    const ctx = pod();
    spawn(ctx, 'P1', swamp());
    const victim = conjure(ctx, 'P2', bear(), 'graveyard');
    const reanimate = conjure(ctx, 'P1', real('Reanimate'), 'hand');
    ctx.state.players[0]!.life = 1;
    const player = ctx.state.players[0]!;
    const cast = computePriorityOptions(ctx, player).find(
      (option) => option.type === 'castSpell' && option.description.includes(reanimate.name),
    )!;
    expect(cast).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, cast.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, victim.id]]),
      }),
    );
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.battlefield.find((p) => p.cardId === victim.cardId)?.controllerId).toBe('P1');
    expect(ctx.state.players[0]!.life).toBe(-1);
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.eliminatedPlayers).toContain('P1');
    expect(ctx.state.battlefield.some((p) => p.cardId === victim.cardId)).toBe(false);
    expect(ctx.state.exile.some((p) => p.cardId === victim.cardId)).toBe(true);
  });

  it.each([true, false])(
    'Queen Allenal replacement must not acquire lifelink (lifelink-first=%s)',
    (lifelinkFirst) => {
      const ctx = pod();
      const queen = spawn(ctx, 'P1', real('Queen Allenal of Ruadach'));
      const dawnCard = real('Dawn of Hope');
      const dawn = spawn(ctx, 'P1', dawnCard);
      for (let i = 0; i < 4; i++) spawn(ctx, 'P1', plains());
      // Seed the plain catalog definition through Queen's real replacement first.
      // The generic producer's differently formatted type line has its own definition.
      if (!lifelinkFirst) {
        const nest = spawn(ctx, 'P1', real('Hornet Nest'));
        dealDamageToCreature(ctx, dawn, nest, 1, {
          combat: false,
          sourceHasDeathtouch: false,
          sourceHasLifelink: false,
        });
        pump(runPrioritySequence(ctx));
      }
      const player = ctx.state.players[0]!;
      const activation = computePriorityOptions(ctx, player).find(
        (option) => option.type === 'activateAbility' && option.description.includes(dawn.name),
      )!;
      expect(activation).toBeDefined();
      pump(
        applyPriorityAction(ctx, player, activation.payload as PriorityActionPayload, {
          index: 0,
          targets: new Map(),
        }),
      );
      pump(resolveTopOfStack(ctx));
      const soldiers = ctx.state.battlefield.filter((p) => p.name === 'Soldier');
      const _actual = soldiers.map((p) => ({
        id: p.id,
        oracleId: p.oracleId,
        keywords: computeCharacteristics(ctx, p).keywords,
      }));
      // The last Soldier is the additional plain 1/1 that Queen Allenal creates.
      expect(computeCharacteristics(ctx, soldiers.at(-1)!).keywords).not.toContain('lifelink');
      expect(computeCharacteristics(ctx, soldiers.at(-2)!).keywords).toContain('lifelink');
      // Queen's anthem-free CDA does not grant lifelink to any creature.
      expect(computeCharacteristics(ctx, queen).keywords).not.toContain('lifelink');
    },
  );
});
