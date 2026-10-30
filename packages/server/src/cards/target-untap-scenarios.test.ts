import { describe, expect, it } from 'vitest';
import { strictCardTestScenario } from './card-test-scenarios';

const outcomes = [
  ['Arachnoid Adaptation', 4, 4, 'reach', 0],
  ["Riverguard's Reflexes", 4, 4, 'first strike', 0],
  ['Acrobatic Leap', 3, 5, 'flying', 0],
  ['Burst of Strength', 3, 3, undefined, 1],
  ['Vines of the Recluse', 3, 4, 'reach', 0],
  ['Dragonscale Boon', 4, 4, undefined, 2],
  ["Witch's Web", 5, 5, 'reach', 0],
  ['Pillar Launch', 4, 4, 'reach', 0],
  ["Bull's Strength", 4, 4, 'trample', 0],
  ['High Stride', 3, 5, 'reach', 0],
  ['Wings of the Cosmos', 3, 5, 'flying', 0],
  ["Tethermage's Advantage", 4, 4, 'reach', 0],
  ['Vault Skyward', 2, 2, 'flying', 0],
  ['Leaping Ambush', 3, 5, 'reach', 0],
  ['Escape from Orthanc', 3, 5, 'flying', 0],
  ['Soldier On', 4, 4, undefined, 2],
] as const;

describe('pinned untap-pronoun lab scenarios', () => {
  it.each(outcomes)(
    'runs %s through the real lab engine without a substituted definition',
    (name, power, toughness, keyword, counters) => {
      const id = `${name
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, '-')}-viewer-target-untap`;
      const scenario = strictCardTestScenario(id, `lab-test-${id}`)!;
      expect(scenario).not.toBeNull();
      const engine = scenario.engine;
      let cast = false;
      let ended = false;
      for (let stepCount = 0; stepCount < 80; stepCount++) {
        const step = engine.advance();
        if (step.kind === 'gameOver') {
          ended = true;
          break;
        }
        if (step.kind !== 'decision') continue;
        const request = step.request;
        const main =
          !cast &&
          request.decidingPlayer === 'P1' &&
          request.legalActions.find(
            (action) => action.type === 'castSpell' && action.description.includes(name),
          );
        const action =
          main ||
          request.legalActions.find((action) => action.type === 'pass') ||
          request.legalActions[0]!;
        if (main) cast = true;
        const targets =
          action.targets?.map((slot) => ({
            slot: slot.slot,
            choice: slot.options.find(
              (id) =>
                engine.view('P1').battlefield.find((p) => p.id === id)?.name ===
                'Chosen Untap Bear',
            )!,
          })) ?? [];
        engine.submit({ requestId: request.requestId, actionId: action.id, targets });
      }
      expect(cast).toBe(true);
      expect(ended).toBe(true);
      const view = engine.view('P1');
      const selected = view.battlefield.find((p) => p.name === 'Chosen Untap Bear')!;
      const other = view.battlefield.find((p) => p.name === 'Other Tapped Bear')!;
      expect([selected.power, selected.toughness]).toEqual([power, toughness]);
      expect(selected.tapped).toBe(false);
      expect(
        engine.getState().battlefield.find((p) => p.id === selected.id)!.counters['+1/+1'] ?? 0,
      ).toBe(counters);
      if (keyword) expect(selected.keywords).toContain(keyword);
      expect([other.power, other.toughness]).toEqual([2, 2]);
      expect(other.tapped).toBe(true);
      expect(engine.getState().players[0]!.graveyard.some((card) => card.name === name)).toBe(true);
    },
  );
});
