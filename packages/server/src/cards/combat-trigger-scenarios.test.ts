import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DecisionRequest, DecisionResponse, OracleCard, PlayerId } from '@mtg/shared';
import { createCardTestScenario } from './card-test-scenarios';
import { COMBAT_TRIGGER_SCENARIO_IDS } from './combat-trigger-scenarios';

const pins = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/combat-trigger-oracle.json', 'utf8'),
) as { cards: { card: OracleCard; sha256: string }[] };
const targetFor = (
  scenario: ReturnType<typeof createCardTestScenario>,
  request: DecisionRequest,
  action: DecisionRequest['legalActions'][number],
  target: string,
) =>
  (action.targets ?? []).map((slot) => {
    const found = scenario!.engine
      .getState()
      .battlefield.find((permanent) => permanent.name === target);
    return {
      slot: slot.slot,
      choice: slot.options.includes(found?.id ?? '')
        ? found!.id
        : slot.options.includes(target)
          ? target
          : slot.options[0]!,
    };
  });

function run(id: (typeof COMBAT_TRIGGER_SCENARIO_IDS)[number]) {
  const scenario = createCardTestScenario(id, `combat-trigger-${id}`)!;
  const overrides = scenario.decisionProviderOverrides ?? {};
  let decisions = 0;
  let castScriv = false;
  let castBolt = false;
  for (;;) {
    const step = scenario.engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    const request = step.request;
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
      const scrivCast =
        id.startsWith('scriv') && !castScriv
          ? actions.find((action) => action.description.startsWith('Cast Scriv'))
          : undefined;
      const pendingCombatTrigger = scenario.engine.getState().stack.length > 0;
      const bolt =
        (id === 'scriv-viewer-departed-attacker' || id === 'namor-viewer-source-removed') &&
        !castBolt &&
        request.phase === 'combat' &&
        pendingCombatTrigger
          ? actions.find((action) => action.description.includes('Cast Lightning Bolt'))
          : undefined;
      const attack =
        request.decisionType === 'declareAttackers'
          ? actions.find((action) => action.description.startsWith('Declare attackers'))
          : undefined;
      const action =
        scrivCast ??
        bolt ??
        attack ??
        actions.find((candidate) => candidate.type === 'pass') ??
        actions[0]!;
      const target = scrivCast
        ? 'Lab Bear'
        : bolt
          ? id.startsWith('namor')
            ? 'Namor, Atlantean King'
            : 'Lab Bear'
          : id.startsWith('marchesa') || id.startsWith('namor')
            ? 'P2'
            : 'P2';
      const targets = targetFor(scenario, request, action, target);
      if (scrivCast) castScriv = true;
      if (bolt) castBolt = true;
      response = {
        requestId: request.requestId,
        actionId: action.id,
        ...(targets.length ? { targets } : {}),
      };
    }
    if (!Number.isInteger(response.actionId))
      throw new Error(
        `${id}: bad provider response for ${request.decidingPlayer} ${request.decisionType}/${request.step}: ${JSON.stringify(request.legalActions)}; response ${JSON.stringify(response)}`,
      );
    scenario.engine.submit(response);
    if (++decisions > 400) throw new Error(`${id} exceeded 400 decisions`);
  }
  return { scenario, decisions, castScriv, castBolt };
}

describe('pinned combat trigger viewer scenarios', () => {
  it('validates exact Oracle pins', () => {
    for (const entry of pins.cards)
      expect(createHash('sha256').update(JSON.stringify(entry.card)).digest('hex')).toBe(
        entry.sha256,
      );
  });

  it.each(COMBAT_TRIGGER_SCENARIO_IDS)(
    '%s creates a bounded real viewer route and resolves its outcome',
    (id) => {
      const { scenario, decisions, castScriv, castBolt } = run(id);
      const state = scenario.engine.getState();
      expect(decisions).toBeLessThanOrEqual(400);
      const sourceName = id.startsWith('marchesa')
        ? 'Marchesa, the Black Rose'
        : id.startsWith('namor')
          ? 'Namor, Atlantean King'
          : 'Scriv, the Obligator';
      expect(scenario.metadata.oracleSha256).toBe(
        pins.cards.find((entry) => entry.card.name === sourceName)!.sha256,
      );
      if (id.startsWith('marchesa')) {
        const marchesa = state.battlefield.find(
          (permanent) => permanent.name === 'Marchesa, the Black Rose',
        );
        expect(state.players.find((player) => player.id === 'P2')!.life).toBe(
          id.endsWith('response') ? 34 : 36,
        );
        expect(marchesa?.counters['+1/+1'] ?? 0).toBe(id.endsWith('response') ? 1 : 0);
        if (id.endsWith('response'))
          expect(
            state.players
              .find((player) => player.id === 'P3')!
              .graveyard.some((card) => card.name === 'Lightning Bolt'),
          ).toBe(true);
      } else if (id.startsWith('namor')) {
        expect(state.players.find((player) => player.id === 'P2')!.life).toBe(
          id.endsWith('removed') ? 37 : 35,
        );
        if (id.endsWith('removed')) {
          expect(
            state.battlefield.some((permanent) => permanent.name === 'Namor, Atlantean King'),
          ).toBe(false);
          expect(
            state.players
              .find((player) => player.id === 'P3')!
              .graveyard.some((card) => card.name === 'Lightning Bolt'),
          ).toBe(true);
        }
      } else {
        expect(castScriv).toBe(true);
        expect(state.players.find((player) => player.id === 'P2')!.life).toBe(
          id.endsWith('controller') ? 38 : 40,
        );
        expect(castBolt).toBe(id.includes('departed'));
        if (id.includes('departed')) {
          expect(
            state.players
              .find((player) => player.id === 'P1')!
              .graveyard.some((card) => card.name === 'Lightning Bolt'),
          ).toBe(true);
          expect(
            state.players
              .find((player) => player.id === 'P2')!
              .graveyard.some((card) => card.name === 'Lab Bear'),
          ).toBe(true);
        }
      }
    },
  );
});
