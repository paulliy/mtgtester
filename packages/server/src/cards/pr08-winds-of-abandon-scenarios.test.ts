import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DecisionRequest, OracleCard } from '@mtg/shared';
import { sha256 } from '../benchmark/hash';
import {
  WINDS_OF_ABANDON_SCENARIO_IDS,
  pr08WindsOfAbandonScenario,
} from './pr08-winds-of-abandon-scenarios';

const pins = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8'),
) as { cards: { card: OracleCard; sha256: string }[] };

function run(id: (typeof WINDS_OF_ABANDON_SCENARIO_IDS)[number]) {
  const scenario = pr08WindsOfAbandonScenario(id, `winds-${id}`);
  const overload = id === WINDS_OF_ABANDON_SCENARIO_IDS[1];
  let castDescription: string | undefined;
  let castManaCost: unknown;
  let castTargets: unknown;
  const choices: Array<{ player: string; prompt: string; action: string }> = [];
  let decisions = 0;
  for (;;) {
    const step = scenario.engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    const request = step.request as DecisionRequest;
    if (request.decidingPlayer !== 'P1') {
      const provider = scenario.decisionProviderOverrides?.[request.decidingPlayer];
      if (provider === undefined)
        throw new Error(`Missing scripted provider for ${request.decidingPlayer}`);
      const response = provider.decide(request);
      const action = request.legalActions.find((candidate) => candidate.id === response.actionId);
      if (request.prompt.toLowerCase().includes('search for a basic land'))
        choices.push({
          player: request.decidingPlayer,
          prompt: request.prompt,
          action: action?.description ?? '',
        });
      scenario.engine.submit(response);
    } else {
      let action = request.legalActions.find(
        (candidate) =>
          castDescription === undefined &&
          candidate.type === 'castSpell' &&
          candidate.description.startsWith('Cast Winds of Abandon') &&
          candidate.description.includes('via Overload') === overload,
      );
      let targets: Array<{ slot: number; choice: string }> | undefined;
      if (action !== undefined) {
        castDescription = action.description;
        castManaCost = action.data?.['manaCost'];
        const targetPermanent = scenario.engine
          .getState()
          .battlefield.find((permanent) => permanent.name === 'Lab P2 Creature');
        const targetSlot = action.targets?.[0];
        castTargets = action.targets;
        if (!overload) {
          if (
            targetPermanent === undefined ||
            targetSlot === undefined ||
            !targetSlot.options.includes(targetPermanent.id)
          )
            throw new Error('Targeted Winds cast omitted Lab P2 Creature');
          targets = [{ slot: targetSlot.slot, choice: targetPermanent.id }];
        }
      }
      action ??=
        request.legalActions.find((candidate) => candidate.type === 'pass') ??
        request.legalActions[0]!;
      scenario.engine.submit({
        requestId: request.requestId,
        actionId: action.id,
        ...(targets === undefined ? {} : { targets }),
      });
    }
    if (++decisions > 300) throw new Error(`${id} exceeded 300 decisions`);
  }
  return { scenario, castDescription, castManaCost, castTargets, choices, decisions };
}

describe('pinned Winds of Abandon viewer scenarios', () => {
  it('validates the exact Oracle pin', () => {
    for (const entry of pins.cards) expect(sha256(entry.card)).toBe(entry.sha256);
  });

  it.each(WINDS_OF_ABANDON_SCENARIO_IDS)(
    '%s uses the selected real cast mode and resolves controller searches',
    (id) => {
      const { scenario, castDescription, castManaCost, castTargets, choices, decisions } = run(id);
      const state = scenario.engine.getState();
      const pin = pins.cards.find((entry) => entry.card.name === 'Winds of Abandon')!;
      const overload = id === WINDS_OF_ABANDON_SCENARIO_IDS[1];
      expect(scenario.metadata.oracleSha256).toBe(pin.sha256);
      expect(scenario.metadata.clauseIds).toEqual([
        overload
          ? 'winds-of-abandon-overload-exile-search'
          : 'winds-of-abandon-targeted-exile-search',
      ]);
      expect(decisions).toBeLessThanOrEqual(300);
      expect(castDescription).toContain('Winds of Abandon');
      expect(castManaCost).toBe(overload ? '{4}{W}{W}' : '{1}{W}');
      expect(castTargets ?? []).toHaveLength(overload ? 0 : 1);
      expect(
        state.eventLog.filter((event) => event.type === 'tapForMana' && event.actorSeat === 'P1'),
      ).toHaveLength(overload ? 6 : 2);
      expect(
        state.eventLog.some(
          (event) => event.type === 'castSpell' && event.payload['name'] === 'Winds of Abandon',
        ),
      ).toBe(true);
      expect(choices.map((choice) => choice.player).sort()).toEqual(
        overload ? ['P2', 'P3'] : ['P2'],
      );
      expect(choices.every((choice) => /search for a basic land/.test(choice.prompt))).toBe(true);
      if (overload) {
        expect(state.battlefield.some((permanent) => permanent.name === 'Lab P1 Creature')).toBe(
          true,
        );
        expect(
          state.battlefield.some(
            (permanent) => permanent.name.includes('Creature') && permanent.controllerId !== 'P1',
          ),
        ).toBe(false);
        expect(state.exile.some((card) => card.name === 'Lab P2 Creature')).toBe(true);
        expect(state.exile.some((card) => card.name === 'Lab P3 Creature')).toBe(true);
        expect(choices.map((choice) => choice.action).join('\n')).toMatch(/Plains[\s\S]*Forest/);
      } else {
        expect(state.exile.some((card) => card.name === 'Lab P2 Creature')).toBe(true);
        expect(state.battlefield.some((permanent) => permanent.name === 'Lab P3 Creature')).toBe(
          false,
        );
      }
      const searched = state.battlefield.filter(
        (permanent) =>
          ['Plains', 'Forest'].includes(permanent.name) && permanent.controllerId !== 'P1',
      );
      expect(searched.map((permanent) => permanent.name).sort()).toEqual(
        overload ? ['Forest', 'Plains'] : ['Plains'],
      );
      expect(searched.every((permanent) => permanent.tapped)).toBe(true);
      const expectedShuffles = overload ? ['P2', 'P3'] : ['P2'];
      expect(
        state.eventLog
          .filter(
            (event) =>
              event.type === 'shuffle' &&
              expectedShuffles.includes(String(event.payload['player'])),
          )
          .map((event) => event.payload['player'])
          .sort(),
      ).toEqual(expectedShuffles);
    },
  );
});
