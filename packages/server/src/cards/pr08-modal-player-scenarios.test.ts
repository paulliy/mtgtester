import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DecisionRequest, OracleCard } from '@mtg/shared';
import { sha256 } from '../benchmark/hash';
import {
  PR08_MODAL_PLAYER_SCENARIO_IDS,
  pr08ModalPlayerScenario,
} from './pr08-modal-player-scenarios';

const pins = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8'),
) as { cards: { card: OracleCard; sha256: string }[] };

function run(id: (typeof PR08_MODAL_PLAYER_SCENARIO_IDS)[number]) {
  const scenario = pr08ModalPlayerScenario(id, `modal-player-${id}`);
  const shadrix = id.startsWith('shadrix-');
  const declined = id === PR08_MODAL_PLAYER_SCENARIO_IDS[1];
  const lichThree = id === PR08_MODAL_PLAYER_SCENARIO_IDS[3];
  let castDescription: string | undefined;
  let castManaCost: unknown;
  let murderDescription: string | undefined;
  let modeChoice: string | undefined;
  const chosenTargets: string[] = [];
  let decisions = 0;
  for (;;) {
    const step = scenario.engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    const request = step.request as DecisionRequest;
    const actions = request.legalActions;
    if (request.decidingPlayer !== 'P1') {
      const provider = scenario.decisionProviderOverrides?.[request.decidingPlayer];
      if (provider === undefined) throw new Error(`Missing provider for ${request.decidingPlayer}`);
      const response = provider.decide(request);
      const action = actions.find((candidate) => candidate.id === response.actionId);
      if (request.decidingPlayer === 'P2' && action?.type === 'castSpell')
        murderDescription = action.description;
      scenario.engine.submit(response);
    } else {
      let action = actions.find(
        (candidate) =>
          castDescription === undefined &&
          candidate.type === 'castSpell' &&
          candidate.description.startsWith(
            `Cast ${shadrix ? 'Shadrix Silverquill' : 'Vindictive Lich'}`,
          ),
      );
      let targets: Array<{ slot: number; choice: string }> | undefined;
      if (action !== undefined) {
        castDescription = action.description;
        castManaCost = action.data?.['manaCost'];
      } else if (request.prompt.includes('choose modes')) {
        action = actions.find((candidate) =>
          declined
            ? candidate.description === 'Choose no modes'
            : shadrix
              ? candidate.description.includes('Target player creates an Inkling') &&
                candidate.description.includes('Target player draws a card and loses 1 life')
              : candidate.description.split('; ').length === (lichThree ? 3 : 2) &&
                candidate.description.includes('Target opponent loses 5 life') &&
                candidate.description.includes('Target opponent discards two cards') &&
                (!lichThree ||
                  candidate.description.includes('Target opponent sacrifices a creature')),
        );
        if (action === undefined) throw new Error(`${id} offered no expected mode choice`);
        modeChoice = action.description;
      } else if (request.decisionType === 'chooseTargets') {
        action = actions[0];
        const slot = action?.targets?.[0];
        if (action === undefined || slot === undefined)
          throw new Error('Missing target action slot');
        const wanted = shadrix
          ? chosenTargets.length === 0
            ? 'P2'
            : 'P3'
          : chosenTargets.length === 0
            ? 'P2'
            : 'P3';
        if (!slot.options.includes(wanted))
          throw new Error(`${wanted} is not legal for ${request.prompt}`);
        chosenTargets.push(wanted);
        targets = [{ slot: slot.slot, choice: wanted }];
      } else if (request.decisionType === 'declareAttackers') {
        action = actions.find((candidate) => candidate.type === 'attackDeclaration');
        targets = action?.targets?.map((slot) => ({
          slot: slot.slot,
          choice: slot.options.find((option) => option === '__no_attack__') ?? slot.options[0]!,
        }));
      } else if (request.decisionType === 'declareBlockers') {
        action = actions.find((candidate) => candidate.type === 'blockDeclaration');
        targets = action?.targets?.map((slot) => ({
          slot: slot.slot,
          choice: slot.options.find((option) => option === '__no_block__') ?? slot.options[0]!,
        }));
      }
      action ??= actions.find((candidate) => candidate.type === 'pass') ?? actions[0]!;
      scenario.engine.submit({
        requestId: request.requestId,
        actionId: action.id,
        ...(targets === undefined ? {} : { targets }),
      });
    }
    if (++decisions > 500) throw new Error(`${id} exceeded 500 decisions`);
  }
  return {
    scenario,
    castDescription,
    castManaCost,
    murderDescription,
    modeChoice,
    chosenTargets,
    decisions,
  };
}

describe('pinned PR08 modal player viewer scenarios', () => {
  it('validates both exact Oracle pins', () => {
    for (const entry of pins.cards) expect(sha256(entry.card)).toBe(entry.sha256);
  });

  it.each(PR08_MODAL_PLAYER_SCENARIO_IDS)(
    '%s casts normally and resolves the intended player choices',
    (id) => {
      const {
        scenario,
        castDescription,
        castManaCost,
        murderDescription,
        modeChoice,
        chosenTargets,
        decisions,
      } = run(id);
      const state = scenario.engine.getState();
      const shadrix = id.startsWith('shadrix-');
      const declined = id === PR08_MODAL_PLAYER_SCENARIO_IDS[1];
      const lichThree = id === PR08_MODAL_PLAYER_SCENARIO_IDS[3];
      const source = pins.cards.find(
        (entry) => entry.card.name === (shadrix ? 'Shadrix Silverquill' : 'Vindictive Lich'),
      )!;
      expect(scenario.metadata.oracleSha256).toBe(source.sha256);
      expect(scenario.metadata.clauseIds).toEqual(
        shadrix
          ? ['shadrix-combat-distinct-modes', 'shadrix-flying-double-strike']
          : ['lich-death-distinct-modes'],
      );
      expect(decisions).toBeLessThanOrEqual(500);
      expect(castDescription).toContain(shadrix ? 'Shadrix Silverquill' : 'Vindictive Lich');
      expect(castManaCost).toBe(shadrix ? '{3}{W}{B}' : '{3}{B}');
      expect(
        state.eventLog.filter((event) => event.type === 'tapForMana' && event.actorSeat === 'P1'),
      ).toHaveLength(shadrix ? 5 : 4);
      if (shadrix) {
        const permanent = state.battlefield.find((card) => card.name === 'Shadrix Silverquill');
        expect(permanent).toBeDefined();
        if (declined) expect(modeChoice).toBe('Choose no modes');
        else expect(modeChoice).toContain('Target player creates an Inkling');
        expect(chosenTargets).toEqual(declined ? [] : ['P2', 'P3']);
        expect(
          state.battlefield.some(
            (card) => card.name.includes('Inkling') && card.controllerId === 'P2',
          ),
        ).toBe(!declined);
        expect(state.players.find((player) => player.id === 'P3')?.life).toBe(declined ? 40 : 39);
      } else {
        expect(murderDescription).toContain('Go for the Throat');
        expect(
          state.eventLog.some(
            (event) => event.type === 'castSpell' && event.payload['name'] === 'Go for the Throat',
          ),
        ).toBe(true);
        expect(
          state.eventLog.filter((event) => event.type === 'tapForMana' && event.actorSeat === 'P2'),
        ).toHaveLength(2);
        expect(
          state.eventLog.some(
            (event) =>
              event.type === 'zoneChange' &&
              event.payload['name'] === 'Vindictive Lich' &&
              event.payload['from'] === 'battlefield' &&
              event.payload['to'] === 'graveyard',
          ),
        ).toBe(true);
        expect(modeChoice).toContain('Target opponent discards two cards');
        expect(chosenTargets).toEqual(['P2', 'P3']);
        if (lichThree) {
          expect(modeChoice).toContain('Target opponent sacrifices a creature');
          expect(modeChoice?.split('; ')).toHaveLength(3);
          expect(chosenTargets).toEqual(['P2', 'P3']); // P4 is the forced third target and is auto-assigned.
          expect(state.battlefield.some((card) => card.name === 'Lab P2 Sacrifice Creature')).toBe(
            false,
          );
          expect(
            state.eventLog.filter(
              (event) =>
                event.type === 'zoneChange' &&
                event.payload['owner'] === 'P2' &&
                event.payload['from'] === 'hand' &&
                event.payload['to'] === 'graveyard',
            ),
          ).toHaveLength(0);
          expect(
            state.eventLog.filter(
              (event) =>
                event.type === 'zoneChange' &&
                event.payload['owner'] === 'P3' &&
                event.payload['from'] === 'hand' &&
                event.payload['to'] === 'graveyard',
            ),
          ).toHaveLength(2);
          expect(state.players.find((player) => player.id === 'P4')?.life).toBe(35);
        } else {
          expect(state.players.find((player) => player.id === 'P3')?.life).toBe(35);
          expect(
            state.eventLog.filter(
              (event) =>
                event.type === 'zoneChange' &&
                event.payload['owner'] === 'P2' &&
                event.payload['from'] === 'hand' &&
                event.payload['to'] === 'graveyard',
            ),
          ).toHaveLength(2);
        }
      }
    },
  );
});
