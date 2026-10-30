import { sha256 } from '../benchmark/hash';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DecisionRequest, DecisionResponse, OracleCard, PlayerId } from '@mtg/shared';
import { strictCardTestScenario } from './card-test-scenarios';
import {
  PR08_CUT_A_DEAL_SCENARIO_IDS,
  pr08CutADealScenarioSubject,
} from './pr08-cut-a-deal-scenarios';

const pins = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8'),
) as { cards: { card: OracleCard; sha256: string }[] };

function run(id: (typeof PR08_CUT_A_DEAL_SCENARIO_IDS)[number]) {
  const scenario = strictCardTestScenario(id, `cut-a-deal-${id}`)!;
  const overrides = scenario.decisionProviderOverrides ?? {};
  let decisions = 0;
  let castSubject = false;
  let castSubjectAction: string | undefined;
  for (;;) {
    const step = scenario.engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    const request = step.request as DecisionRequest;
    let response: DecisionResponse;
    if (request.decidingPlayer !== 'P1') {
      const provider = overrides[request.decidingPlayer as PlayerId];
      if (provider) response = provider.decide(request);
      else {
        const pass =
          request.legalActions.find((action) => action.type === 'pass') ?? request.legalActions[0]!;
        response = { requestId: request.requestId, actionId: pass.id };
      }
    } else {
      const actions = request.legalActions;
      const subject = pr08CutADealScenarioSubject(id);
      const subjectCast = !castSubject
        ? actions.find(
            (action) =>
              action.type === 'castSpell' && action.description.startsWith(`Cast ${subject}`),
          )
        : undefined;
      const action =
        subjectCast ?? actions.find((candidate) => candidate.type === 'pass') ?? actions[0]!;
      if (subjectCast) {
        castSubject = true;
        castSubjectAction = subjectCast.description;
      }
      response = { requestId: request.requestId, actionId: action.id };
    }
    if (!Number.isInteger(response.actionId))
      throw new Error(
        `${id}: bad provider response for ${request.decidingPlayer} ${request.decisionType}/${request.step}: ${JSON.stringify(request.legalActions)}; response ${JSON.stringify(response)}`,
      );
    scenario.engine.submit(response);
    if (++decisions > 200) throw new Error(`${id} exceeded 200 decisions`);
  }
  return {
    scenario,
    decisions,
    castSubject,
    castSubjectAction,
  };
}

/** The replayed `draw` events after `from`, in resolution order. */
function drawEventPlayers(
  state: ReturnType<NonNullable<ReturnType<typeof strictCardTestScenario>>['engine']['getState']>,
): string[] {
  return state.eventLog
    .filter((event) => event.type === 'draw')
    .map((event) => String(event.payload['player']));
}

describe('pinned Cut a Deal viewer scenarios', () => {
  it('validates the exact Oracle pin', () => {
    for (const entry of pins.cards) expect(sha256(entry.card)).toBe(entry.sha256);
  });

  it.each(PR08_CUT_A_DEAL_SCENARIO_IDS)(
    '%s creates a bounded real viewer route and resolves its outcome',
    (id) => {
      const { scenario, decisions, castSubject, castSubjectAction } = run(id);
      const state = scenario.engine.getState();
      expect(decisions).toBeLessThanOrEqual(200);
      const pin = pins.cards.find((entry) => entry.card.name === pr08CutADealScenarioSubject(id))!;
      expect(scenario.metadata.oracleSha256).toBe(pin.sha256);
      expect(castSubject).toBe(true);
      expect(castSubjectAction).toContain(pin.card.manaCost);
      expect(castSubjectAction).not.toContain('without paying');
      expect(
        state.eventLog.some(
          (event) => event.type === 'castSpell' && event.payload['name'] === 'Cut a Deal',
        ),
      ).toBe(true);
      const hand = (playerId: string) =>
        state.players.find((player) => player.id === playerId)!.hand.length;
      if (id === 'cut-a-deal-viewer-full-draw') {
        expect(drawEventPlayers(state)).toEqual(['P2', 'P3', 'P4', 'P1', 'P1', 'P1']);
        expect(hand('P1')).toBe(3);
        expect(hand('P2')).toBe(1);
        expect(hand('P3')).toBe(1);
        expect(hand('P4')).toBe(1);
        expect(state.players.every((player) => !player.hasLost)).toBe(true);
      } else {
        // P3's library is empty: the instruction is not a draw, so only P2 and P4 drew and
        // the caster draws two (the count is fixed before the empty-library flag is set).
        expect(drawEventPlayers(state)).toEqual(['P2', 'P4', 'P1', 'P1']);
        expect(
          state.eventLog.some(
            (event) => event.type === 'drawFromEmptyLibrary' && event.payload['player'] === 'P3',
          ),
        ).toBe(true);
        expect(hand('P1')).toBe(2);
        expect(hand('P2')).toBe(1);
        expect(hand('P3')).toBe(0);
        expect(hand('P4')).toBe(1);
        // The empty-library loss is the next state-based action, never inside the resolution.
        expect(state.players.find((player) => player.id === 'P3')!.hasLost).toBe(true);
        expect(state.players.find((player) => player.id === 'P1')!.hasLost).toBe(false);
      }
    },
  );
});
