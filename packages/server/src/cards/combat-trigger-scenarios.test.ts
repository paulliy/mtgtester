import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NO_ATTACK_TARGET } from '@mtg/shared';
import type { DecisionRequest, DecisionResponse, OracleCard, PlayerId } from '@mtg/shared';
import { createCardTestScenario } from './card-test-scenarios';
import {
  COMBAT_TRIGGER_SCENARIO_IDS,
  combatTriggerScenarioSubject,
} from './combat-trigger-scenarios';

const pins = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/combat-trigger-oracle.json', 'utf8'),
) as { cards: { card: OracleCard; sha256: string }[] };
const targetFor = (
  scenario: ReturnType<typeof createCardTestScenario>,
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
  let castSubject = false;
  let castSubjectAction: string | undefined;
  let castScriv = false;
  let castBolt = false;
  let declinedTemurDraw = false;
  let huntedTargetOptions: string[] | undefined;
  let huntedTargetChoice: string | undefined;
  const subject = combatTriggerScenarioSubject(id);
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
      const subjectCast = !castSubject
        ? actions.find(
            (action) =>
              action.type === 'castSpell' && action.description.startsWith(`Cast ${subject}`),
          )
        : undefined;
      const scrivCast =
        id.startsWith('scriv') && !castScriv
          ? actions.find((action) => action.description.startsWith('Cast Scriv'))
          : undefined;
      const declineTemurDraw =
        id === 'dragon-mage-viewer-normal-cast-wheel' && request.decisionType === 'optionalTrigger'
          ? actions.find((action) => action.description === 'No')
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
      if (
        id === 'hunted-phantasm-viewer-opponent-tokens' &&
        request.decisionType === 'chooseTargets' &&
        request.prompt.includes('Hunted Phantasm')
      ) {
        huntedTargetOptions = (actions[0]?.targets ?? []).flatMap((slot) =>
          slot.options.map(String),
        );
      }
      const action =
        scrivCast ??
        subjectCast ??
        bolt ??
        declineTemurDraw ??
        attack ??
        actions.find((candidate) => candidate.type === 'pass') ??
        actions[0]!;
      const target = scrivCast
        ? 'Lab Bear'
        : bolt
          ? id.startsWith('namor')
            ? 'Namor, Atlantean King'
            : 'Lab Bear'
          : 'P2';
      const targets =
        id === 'marchesa-viewer-granted-dethrone' && attack
          ? (action.targets ?? []).map((slot) => ({
              slot: slot.slot,
              // The prepared order is Lab Bear, then Marchesa after the cast. Marchesa stays back.
              choice: slot.slot === 0 ? 'P2' : NO_ATTACK_TARGET,
            }))
          : targetFor(scenario, action, target);
      if (
        id === 'hunted-phantasm-viewer-opponent-tokens' &&
        request.decisionType === 'chooseTargets' &&
        request.prompt.includes('Hunted Phantasm')
      ) {
        huntedTargetChoice = targets[0]?.choice;
      }
      if (subjectCast) {
        castSubject = true;
        castSubjectAction = subjectCast.description;
      }
      if (scrivCast) castScriv = true;
      if (bolt) castBolt = true;
      if (declineTemurDraw) declinedTemurDraw = true;
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
  return {
    scenario,
    decisions,
    castSubject,
    castSubjectAction,
    castScriv,
    castBolt,
    declinedTemurDraw,
    huntedTargetOptions,
    huntedTargetChoice,
  };
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
      const {
        scenario,
        decisions,
        castSubject,
        castSubjectAction,
        castScriv,
        castBolt,
        declinedTemurDraw,
        huntedTargetOptions,
        huntedTargetChoice,
      } = run(id);
      const state = scenario.engine.getState();
      expect(decisions).toBeLessThanOrEqual(400);
      const sourceName = combatTriggerScenarioSubject(id);
      const sourcePin = pins.cards.find((entry) => entry.card.name === sourceName)!;
      expect(scenario.metadata.oracleSha256).toBe(sourcePin.sha256);
      expect(castSubject).toBe(true);
      expect(castSubjectAction).toContain(sourcePin.card.manaCost);
      expect(castSubjectAction).not.toContain('without paying');
      expect(
        state.eventLog.some(
          (event) => event.type === 'castSpell' && event.payload['name'] === sourceName,
        ),
      ).toBe(true);
      if (id.startsWith('marchesa')) {
        const marchesa = state.battlefield.find(
          (permanent) => permanent.name === 'Marchesa, the Black Rose',
        );
        const grantedDethrone = id === 'marchesa-viewer-granted-dethrone';
        expect(state.players.find((player) => player.id === 'P2')!.life).toBe(
          grantedDethrone ? 35 : id.endsWith('response') ? 34 : 36,
        );
        expect(marchesa?.counters['+1/+1'] ?? 0).toBe(id.endsWith('response') ? 1 : 0);
        if (grantedDethrone) {
          expect(
            state.battlefield.find((permanent) => permanent.name === 'Lab Bear')?.counters['+1/+1'],
          ).toBe(1);
          expect(
            state.players
              .find((player) => player.id === 'P3')!
              .graveyard.some((card) => card.name === 'Lightning Bolt'),
          ).toBe(true);
        }
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
      } else if (id.startsWith('scriv')) {
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
      } else if (id === 'dragon-mage-viewer-normal-cast-wheel') {
        expect(state.players.find((player) => player.id === 'P2')!.life).toBe(35);
        expect(state.players.every((player) => player.hand.length === 7)).toBe(true);
        expect(state.eventLog.filter((event) => event.type === 'discard')).toHaveLength(4);
        for (const player of state.players)
          expect(
            state.eventLog.filter(
              (event) => event.type === 'draw' && event.payload['player'] === player.id,
            ),
          ).toHaveLength(7);
        expect(declinedTemurDraw).toBe(true);
      } else {
        expect(state.players.find((player) => player.id === 'P2')!.life).toBe(36);
        expect(
          state.battlefield.filter(
            (permanent) => permanent.controllerId === 'P2' && permanent.name === 'Goblin',
          ),
        ).toHaveLength(5);
        expect(huntedTargetChoice).toBe('P2');
        expect(huntedTargetOptions).toContain('P2');
        expect(huntedTargetOptions).not.toContain('P1');
      }
    },
  );
});
