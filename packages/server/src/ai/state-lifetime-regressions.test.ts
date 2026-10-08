import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { DecisionRequest, DecisionResponse, OracleCard } from '@mtg/shared';
import { NO_ATTACK_TARGET, NO_BLOCK_TARGET } from '@mtg/shared';
import { Engine } from '../../../engine/src/engine';
import type { GameContext } from '../../../engine/src/state/types';
import { interpretCard } from '../../../engine/src/cards/interpret';
import {
  copies,
  forest,
  gameConfig,
  keywordCreature,
  plains,
  spawn,
} from '../../../engine/tests/fixtures';
import { DEFAULT_AI_CONFIG } from './config';
import type { AiClient } from './client';
import { OpenAiDecisionProvider } from './provider';
import { StrategyCoordinator } from './strategy-coordinator';
import { digestDecision } from './decision-cache';

type AiResult = Awaited<ReturnType<AiClient['requestDecision']>>;
const queue = { enqueue: <T>(fn: () => Promise<T>) => fn() };
function result(response: DecisionResponse): AiResult {
  return {
    response,
    meta: {
      model: 'deterministic-fixture',
      promptTokens: 100,
      responseTokens: 20,
      latencyMs: 1,
      wasRetry: false,
      wasFallback: false,
      rawResponse: '{}',
    },
  };
}
function first(request: DecisionRequest): DecisionResponse {
  const action = request.legalActions[0]!;
  return {
    requestId: request.requestId,
    actionId: action.id,
    targets: action.targets?.map((slot) => ({ slot: slot.slot, choice: slot.options[0]! })) ?? [],
  };
}

describe('AI state and complete cache contracts', () => {
  it.each(['delayed', 'early'] as const)(
    'must not repeat a completed own action when a %s same-phase strategist response arrives',
    async (arrival) => {
      const fixture = JSON.parse(
        readFileSync('packages/engine/tests/fixtures/bug-hunt-oracle.json', 'utf8'),
      ) as { cards: { card: OracleCard }[] };
      const dawn = fixture.cards
        .map((entry) => entry.card)
        .find((card) => card.name === 'Dawn of Hope')!;
      expect(interpretCard(dawn).modeled).toBe(true);
      const engine = new Engine(
        gameConfig([{ cards: [dawn, ...copies(12, plains)] }, { cards: copies(8, forest) }]),
        {
          preparedScenario: {
            currentTurnPlayer: 'P1',
            phase: 'precombatMain',
            step: null,
            turnNumber: 4,
            hand: [],
            battlefield: [{ playerId: 'P1', cardNames: [dawn.name, ...Array(8).fill('Plains')] }],
          },
        },
      );
      const dawnSource = engine.view('P1').battlefield.find((item) => item.name === dawn.name)!;
      let deliver!: (value: AiResult) => void;
      const deferred = new Promise<AiResult>((resolve) => {
        deliver = resolve;
      });
      let strategySignal: AbortSignal | undefined;
      const strategist = {
        activeModel: 'deterministic-fixture',
        requestDecision: vi.fn((_prompt, _request, signal?: AbortSignal) => {
          strategySignal = signal;
          return deferred;
        }),
      } as unknown as AiClient;
      let tacticalActivations = 0;
      const tactician = {
        activeModel: 'deterministic-fixture',
        requestDecision: vi.fn(async (_prompt, request: DecisionRequest) => {
          const activation = request.legalActions.find(
            (action) => action.type === 'activateAbility' && action.description.includes(dawn.name),
          );
          if (
            activation &&
            tacticalActivations === 0 &&
            engine.view('P1').stack.length === 0 &&
            !engine.view('P1').battlefield.some((item) => item.name === 'Soldier')
          ) {
            tacticalActivations++;
            return result({ requestId: request.requestId, actionId: activation.id });
          }
          return result(first(request));
        }),
      } as unknown as AiClient;
      const config = { ...DEFAULT_AI_CONFIG, decisionCacheEnabled: false };
      const coordinator = new StrategyCoordinator(strategist, queue, engine, config);
      const provider = new OpenAiDecisionProvider(
        tactician,
        queue,
        engine,
        config,
        undefined,
        undefined,
        coordinator,
      );
      const plannedResult = result({
        requestId: 'test-game-t4-P1-strategy',
        actionId: 0,
        turnStrategy: {
          intent:
            'Create exactly one Soldier blocker, then reserve the other four mana for interaction.',
          manaPlan: 'Spend four mana once and reserve four.',
          plannedActions: [
            {
              id: 'one-soldier',
              type: 'activateAbility',
              name: dawn.name,
              source: { objectId: dawnSource.id, name: dawn.name },
              phase: 'precombatMain',
              step: null,
              objective: 'Create exactly one blocker',
              expectedEffect: 'One Soldier is created',
            },
          ],
        },
      });
      let delivered = false;
      let _duplicate: DecisionResponse | undefined;
      for (let i = 0; i < 150; i++) {
        const step = engine.advance();
        if (step.kind === 'gameOver') break;
        if (step.kind !== 'decision') continue;
        const request = step.request;
        const soldiers = engine.view('P1').battlefield.filter((item) => item.name === 'Soldier');
        if (!delivered && arrival === 'early' && request.decidingPlayer === 'P1') {
          coordinator.prepare(request);
          delivered = true;
          deliver(plannedResult);
          await coordinator.settled();
          expect(coordinator.guidanceFor('P1').strategy?.intent).toBe(
            plannedResult.response.turnStrategy!.intent,
          );
        }
        if (
          !delivered &&
          soldiers.length === 1 &&
          request.decidingPlayer === 'P1' &&
          engine.view('P1').stack.length === 0
        ) {
          delivered = true;
          deliver(plannedResult);
          await coordinator.settled();
          expect(coordinator.guidanceFor('P1').strategy?.intent).toBe(
            plannedResult.response.turnStrategy!.intent,
          );
        }
        const response =
          request.decidingPlayer === 'P1' ? await provider.decide(request) : first(request);
        if (delivered && response.note?.startsWith('TurnPlan:')) _duplicate = response;
        engine.submit(response);
        coordinator.recordAcceptedDecision(request, response);
        if (engine.view('P1').battlefield.filter((item) => item.name === 'Soldier').length === 2)
          break;
      }
      expect(delivered).toBe(true);
      expect(strategySignal?.aborted).toBe(false);
      expect(strategist.requestDecision).toHaveBeenCalledTimes(1);
      expect(
        coordinator.planLifecycle().some((event) => event.status === 'already_accomplished'),
      ).toBe(arrival === 'delayed');
      expect(tacticalActivations).toBe(arrival === 'delayed' ? 1 : 0);
      const soldiers = engine.view('P1').battlefield.filter((item) => item.name === 'Soldier');
      expect(soldiers).toHaveLength(1);
    },
  );

  it.each([true, false])(
    'must keep combat split targets and preserve the full response for same-name attackers with caching=%s',
    async (decisionCacheEnabled) => {
      const engine = new Engine(
        gameConfig([{ cards: copies(16, forest) }, { cards: copies(16, forest) }]),
      );
      // Arrange the board only, as the engine's combat tests do. All subsequent opening,
      // turn, priority, attack/block, division and damage paths use public advance/submit.
      const ctx = (engine as unknown as { ctx: GameContext }).ctx;
      const raiders = [
        spawn(ctx, 'P1', keywordCreature('Beast', '', '{3}{G}', '3/3')),
        spawn(ctx, 'P1', keywordCreature('Beast', '', '{3}{G}', '3/3')),
      ];
      for (let i = 0; i < 4; i++) spawn(ctx, 'P2', keywordCreature('Wall', '', '{2}', '0/4'));
      const client = {
        activeModel: 'deterministic-fixture',
        requestDecision: vi.fn(async (_prompt, request: DecisionRequest) => {
          const targets = request.combatDamageSplit!.targets;
          return result({
            requestId: request.requestId,
            actionId: 0,
            combatDamageSplit: { [targets[0]!]: 2, [targets[1]!]: 1 },
          });
        }),
      } as unknown as AiClient;
      const provider = new OpenAiDecisionProvider(client, queue, engine, {
        ...DEFAULT_AI_CONFIG,
        strategistEnabled: false,
        decisionCacheEnabled,
      });
      const requests: DecisionRequest[] = [];
      const digests: number[] = [];
      const responses: DecisionResponse[] = [];
      for (let i = 0; i < 300; i++) {
        const step = engine.advance();
        if (step.kind === 'gameOver') break;
        if (step.kind !== 'decision') continue;
        const request = step.request;
        let response = first(request);
        if (request.decisionType === 'declareAttackers') {
          response.targets = request.legalActions[0]!.targets!.map((slot) => ({
            slot: slot.slot,
            choice: request.decidingPlayer === 'P1' ? 'P2' : NO_ATTACK_TARGET,
          }));
        } else if (request.decisionType === 'declareBlockers') {
          response.targets = request.legalActions[0]!.targets!.map((slot) => ({
            slot: slot.slot,
            choice:
              request.decidingPlayer === 'P2'
                ? raiders[Math.floor(slot.slot / 2)]!.id
                : NO_BLOCK_TARGET,
          }));
        } else if (request.decisionType === 'assignCombatDamage') {
          requests.push(request);
          digests.push(digestDecision(request, engine.view(request.decidingPlayer)));
          response = await provider.decide(request);
          responses.push(response);
        }
        engine.submit(response);
        if (responses.length === 2) {
          // Resume far enough to apply both divisions, then retain the resulting event log.
          engine.advance();
          break;
        }
      }
      expect(requests).toHaveLength(2);
      expect(requests[0]!.combatDamageSplit!.targets).not.toEqual(
        requests[1]!.combatDamageSplit!.targets,
      );
      const divisions = engine
        .eventsSince(0)
        .filter((event) => event.type === 'damageAssignmentDivision');
      expect(divisions).toHaveLength(2);
      expect(responses[1]!.combatDamageSplit).toEqual({
        [requests[1]!.combatDamageSplit!.targets[0]!]: 2,
        [requests[1]!.combatDamageSplit!.targets[1]!]: 1,
      });
    },
  );
});
