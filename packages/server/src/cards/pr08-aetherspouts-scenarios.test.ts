import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DecisionRequest, OracleCard } from '@mtg/shared';
import { sha256 } from '../benchmark/hash';
import { AETHERSPOUTS_SCENARIO_IDS, pr08AetherspoutsScenario } from './pr08-remaining-scenarios';

const pins = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8'),
) as { cards: { card: OracleCard; sha256: string }[] };

function run(id: (typeof AETHERSPOUTS_SCENARIO_IDS)[number]) {
  const scenario = pr08AetherspoutsScenario(id, `aetherspouts-${id}`);
  let castAction: string | undefined;
  const ownerChoices: Array<{ prompt: string; action: string }> = [];
  let decisions = 0;
  for (;;) {
    const step = scenario.engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    const request = step.request as DecisionRequest;
    const actions = request.legalActions;
    if (request.decidingPlayer === 'P2') {
      const provider = scenario.decisionProviderOverrides?.['P2'];
      if (provider === undefined) throw new Error('Missing scripted P2 provider');
      scenario.engine.submit(provider.decide(request));
      if (++decisions > 300) throw new Error(`${id} exceeded 300 decisions`);
      continue;
    }
    let action = actions.find(
      (candidate) =>
        !castAction &&
        candidate.type === 'castSpell' &&
        candidate.description.startsWith('Cast Aetherspouts') &&
        request.phase === 'combat' &&
        request.step === 'declareBlockers',
    );
    let targets: Array<{ slot: number; choice: string }> = [];
    if (action) castAction = action.description;
    if (
      !action &&
      request.decidingPlayer === 'P1' &&
      request.prompt.toLowerCase().includes('top or bottom')
    ) {
      const alphaTop = id === AETHERSPOUTS_SCENARIO_IDS[0];
      const wantsTop = request.prompt.includes('Lab P1 Attacker Alpha') === alphaTop;
      action = actions.find((candidate) =>
        (wantsTop ? /top/i : /bottom/i).test(candidate.description),
      );
      if (action) ownerChoices.push({ prompt: request.prompt, action: action.description });
    }
    if (!action && request.decidingPlayer === 'P1' && request.decisionType === 'declareBlockers') {
      action = actions.find((candidate) => candidate.type === 'blockDeclaration');
      if (action)
        targets = (action.targets ?? []).map((slot) => ({
          slot: slot.slot,
          choice: slot.options.find((option) => option === '__no_block__') ?? slot.options[0]!,
        }));
    }
    action ??= actions.find((candidate) => candidate.type === 'pass') ?? actions[0]!;
    scenario.engine.submit({
      requestId: request.requestId,
      actionId: action.id,
      ...(targets.length > 0 ? { targets } : {}),
    });
    if (++decisions > 300) throw new Error(`${id} exceeded 300 decisions`);
  }
  return { scenario, castAction, ownerChoices, decisions };
}

describe('pinned Aetherspouts viewer scenarios', () => {
  it('validates the exact Oracle pin', () => {
    for (const entry of pins.cards) expect(sha256(entry.card)).toBe(entry.sha256);
  });

  it.each(AETHERSPOUTS_SCENARIO_IDS)(
    '%s casts after attacks and returns creatures by owner choice',
    (id) => {
      const { scenario, castAction, ownerChoices, decisions } = run(id);
      const state = scenario.engine.getState();
      const pin = pins.cards.find((entry) => entry.card.name === 'Aetherspouts')!;
      expect(scenario.metadata.oracleSha256).toBe(pin.sha256);
      expect(decisions).toBeLessThanOrEqual(300);
      expect(castAction).toContain('{3}{U}{U}');
      expect(castAction).not.toContain('without paying');
      expect(
        state.eventLog.some(
          (event) =>
            event.type === 'castSpell' &&
            event.payload['name'] === 'Aetherspouts' &&
            Array.isArray(event.payload['targets']) &&
            event.payload['targets'].length === 0,
        ),
      ).toBe(true);
      expect(
        state.eventLog.some(
          (event) => event.type === 'attackersDeclared' && event.payload['count'] === 3,
        ),
      ).toBe(true);
      expect(ownerChoices).toHaveLength(2);
      expect(ownerChoices.map(({ prompt, action }) => `${prompt} ${action}`).join('\n')).toMatch(
        id === AETHERSPOUTS_SCENARIO_IDS[0]
          ? /Lab P1 Attacker Alpha.*top[\s\S]*Lab P1 Attacker Beta.*bottom/
          : /Lab P1 Attacker Alpha.*bottom[\s\S]*Lab P1 Attacker Beta.*top/,
      );
      const p1 = state.players.find((player) => player.id === 'P1')!;
      const p2 = state.players.find((player) => player.id === 'P2')!;
      const alphaTop = id === AETHERSPOUTS_SCENARIO_IDS[0];
      expect(p1.library[0]?.name).toBe(alphaTop ? 'Lab P1 Attacker Alpha' : 'Lab P1 Attacker Beta');
      expect(p1.library.at(-1)?.name).toBe(
        alphaTop ? 'Lab P1 Attacker Beta' : 'Lab P1 Attacker Alpha',
      );
      expect(p2.library.at(-1)?.name).toBe('Lab P2 Attacker');
      expect(state.battlefield.some((permanent) => permanent.name.includes('Attacker'))).toBe(
        false,
      );
      expect(
        state.eventLog.filter((event) => event.type === 'tapForMana' && event.actorSeat === 'P1'),
      ).toHaveLength(5);
    },
  );
});
