import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DecisionRequest, OracleCard } from '@mtg/shared';
import { sha256 } from '../benchmark/hash';
import { BOSEIJU_SCENARIO_IDS, pr08BoseijuScenario } from './pr08-boseiju-scenarios';

const pins = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8'),
) as { cards: { card: OracleCard; sha256: string }[] };

function run(id: (typeof BOSEIJU_SCENARIO_IDS)[number]) {
  const scenario = pr08BoseijuScenario(id, `boseiju-${id}`);
  const landMana = id === BOSEIJU_SCENARIO_IDS[2];
  let activationDescription: string | undefined;
  let activationManaCost: unknown;
  let landPlayDescription: string | undefined;
  let spellDescription: string | undefined;
  let searchPrompt = false;
  let forestChoice: string | undefined;
  let decisions = 0;
  for (;;) {
    const step = scenario.engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    const request = step.request as DecisionRequest;
    const actions = request.legalActions;
    if (request.decidingPlayer === 'P2') {
      if (request.prompt.toLowerCase().includes('search your library')) searchPrompt = true;
      const provider = scenario.decisionProviderOverrides?.['P2'];
      if (provider === undefined) throw new Error('Missing scripted P2 provider');
      const response = provider.decide(request);
      const picked = actions.find((candidate) => candidate.id === response.actionId);
      if (request.prompt.toLowerCase().includes('choose a land with a basic land type'))
        forestChoice = picked?.description;
      scenario.engine.submit(response);
    } else {
      if (landMana && landPlayDescription === undefined) {
        const playLand = actions.find(
          (candidate) =>
            candidate.type === 'playLand' && candidate.description.includes('Boseiju, Who Endures'),
        );
        if (playLand !== undefined) {
          landPlayDescription = playLand.description;
          scenario.engine.submit({ requestId: request.requestId, actionId: playLand.id });
          if (++decisions > 300) throw new Error(`${id} exceeded 300 decisions`);
          continue;
        }
      }
      if (landMana && spellDescription === undefined) {
        const spell = actions.find(
          (candidate) =>
            candidate.type === 'castSpell' &&
            candidate.description.startsWith('Cast Lab Green Salve'),
        );
        if (spell !== undefined) {
          spellDescription = spell.description;
          scenario.engine.submit({ requestId: request.requestId, actionId: spell.id });
          if (++decisions > 300) throw new Error(`${id} exceeded 300 decisions`);
          continue;
        }
      }
      let action = actions.find(
        (candidate) =>
          activationDescription === undefined &&
          candidate.type === 'activateAbility' &&
          candidate.description.startsWith('Boseiju, Who Endures (hand):'),
      );
      let targets: Array<{ slot: number; choice: string }> | undefined;
      if (action !== undefined) {
        activationDescription = action.description;
        activationManaCost = action.data?.['manaCost'];
        const artifact = scenario.engine
          .getState()
          .battlefield.find((permanent) => permanent.name === 'Lab P2 Artifact');
        if (artifact === undefined) throw new Error('Missing prepared target artifact');
        const target = action.targets?.find((slot) => slot.options.includes(artifact.id));
        if (target === undefined)
          throw new Error('Boseiju action omitted the prepared artifact target');
        targets = [{ slot: target.slot, choice: artifact.id }];
      }
      action ??= actions.find((candidate) => candidate.type === 'pass') ?? actions[0]!;
      scenario.engine.submit({
        requestId: request.requestId,
        actionId: action.id,
        ...(targets === undefined ? {} : { targets }),
      });
    }
    if (++decisions > 300) throw new Error(`${id} exceeded 300 decisions`);
  }
  return {
    scenario,
    activationDescription,
    activationManaCost,
    landPlayDescription,
    spellDescription,
    searchPrompt,
    forestChoice,
    decisions,
  };
}

describe('pinned Boseiju viewer scenarios', () => {
  it('validates the exact Oracle pin', () => {
    for (const entry of pins.cards) expect(sha256(entry.card)).toBe(entry.sha256);
  });

  it.each(BOSEIJU_SCENARIO_IDS)(
    '%s channels, discards, destroys, and resolves the optional search',
    (id) => {
      const {
        scenario,
        activationDescription,
        activationManaCost,
        landPlayDescription,
        spellDescription,
        searchPrompt,
        forestChoice,
        decisions,
      } = run(id);
      const state = scenario.engine.getState();
      const pin = pins.cards.find((entry) => entry.card.name === 'Boseiju, Who Endures')!;
      const discounted = id === BOSEIJU_SCENARIO_IDS[1];
      expect(scenario.metadata.oracleSha256).toBe(pin.sha256);
      expect(decisions).toBeLessThanOrEqual(300);
      if (id === BOSEIJU_SCENARIO_IDS[2]) {
        expect(scenario.metadata.clauseIds).toEqual(['boseiju-land-mana']);
        expect(landPlayDescription).toBe('Play Boseiju, Who Endures');
        expect(spellDescription).toContain('Lab Green Salve');
        expect(activationDescription).toBeUndefined();
        expect(state.players.find((player) => player.id === 'P1')?.life).toBe(41);
        const land = state.battlefield.find(
          (permanent) => permanent.name === 'Boseiju, Who Endures',
        );
        expect(land?.tapped).toBe(true);
        expect(
          state.eventLog.some(
            (event) =>
              event.type === 'tapForMana' &&
              event.actorSeat === 'P1' &&
              event.payload['name'] === 'Boseiju, Who Endures',
          ),
        ).toBe(true);
        expect(
          state.eventLog.some(
            (event) => event.type === 'castSpell' && event.payload['name'] === 'Lab Green Salve',
          ),
        ).toBe(true);
        expect(
          state.eventLog.some(
            (event) => event.type === 'lifeGain' && event.payload['player'] === 'P1',
          ),
        ).toBe(true);
        return;
      }
      expect(scenario.metadata.clauseIds).toEqual([
        'boseiju-channel-target-search',
        'boseiju-legendary-cost-reduction',
      ]);
      expect(activationDescription).toContain('Channel');
      expect(activationManaCost).toBe(discounted ? '{G}' : '{1}{G}');
      expect(state.battlefield.some((permanent) => permanent.name === 'Lab P2 Artifact')).toBe(
        false,
      );
      const p1 = state.players.find((player) => player.id === 'P1')!;
      const p2 = state.players.find((player) => player.id === 'P2')!;
      expect(p1.hand.some((card) => card.name === 'Boseiju, Who Endures')).toBe(false);
      expect(p1.graveyard.some((card) => card.name === 'Boseiju, Who Endures')).toBe(true);
      expect(
        state.eventLog.some(
          (event) =>
            event.type === 'activateAbility' &&
            event.payload['player'] === 'P1' &&
            event.payload['source'] === 'Boseiju, Who Endures',
        ),
      ).toBe(true);
      expect(
        state.eventLog.some(
          (event) =>
            event.type === 'zoneChange' &&
            event.payload['name'] === 'Boseiju, Who Endures' &&
            event.payload['from'] === 'hand' &&
            event.payload['to'] === 'graveyard',
        ),
      ).toBe(true);
      expect(
        state.eventLog.some(
          (event) =>
            event.type === 'zoneChange' &&
            event.payload['name'] === 'Lab P2 Artifact' &&
            event.payload['from'] === 'battlefield' &&
            event.payload['to'] === 'graveyard',
        ),
      ).toBe(true);
      expect(searchPrompt).toBe(true);
      expect(
        state.eventLog.filter((event) => event.type === 'tapForMana' && event.actorSeat === 'P1'),
      ).toHaveLength(discounted ? 1 : 2);
      if (discounted) {
        expect(forestChoice).toMatch(/Forest/);
        const foundForest = state.battlefield.find(
          (permanent) => permanent.name === 'Forest' && permanent.controllerId === 'P2',
        );
        expect(foundForest).toBeDefined();
        expect(foundForest?.tapped).toBe(false);
        expect(
          state.eventLog.filter(
            (event) => event.type === 'shuffle' && event.payload['player'] === 'P2',
          ),
        ).toHaveLength(1);
      } else {
        expect(forestChoice).toBeUndefined();
        expect(
          state.eventLog.filter(
            (event) => event.type === 'shuffle' && event.payload['player'] === 'P2',
          ),
        ).toHaveLength(0);
        expect(p2.library.map((card) => card.name)).toContain('Forest');
      }
    },
  );
});
