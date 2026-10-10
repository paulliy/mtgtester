import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { interpretCard, ScriptedDecisionProvider } from '@mtg/engine';
import type { DecisionRequest, DecisionResponse, OracleCard } from '@mtg/shared';
import type { EngineState } from '@mtg/engine';
import { createCardTestScenario } from './card-test-scenarios';
import { TRANSFORMED_DFC_CASES } from './transformed-dfc-scenarios';

const pins = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/transformed-dfc-copy-oracle.json', 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };

function run(id: string) {
  const scenario = createCardTestScenario(id, 'transformed-dfc-evidence')!;
  expect(scenario).not.toBeNull();
  const entry = TRANSFORMED_DFC_CASES.find((entry) => entry.id === id)!;
  const spell = entry.token ? 'Quantum Misalignment' : "Dack's Duplicate";
  const face = entry.transformed ? "Brigid, Doun's Mind" : "Brigid, Clachan's Heart";
  let cast = false;
  let defended = false;
  const observations: { player: string; prompt: string; selected: string }[] = [];
  const answer = (request: DecisionRequest): DecisionResponse => {
    const action =
      (!cast
        ? request.legalActions.find((action) => action.description.startsWith(`Cast ${spell}`))
        : undefined) ??
      request.legalActions.find((action) => action.description.startsWith(`Copy ${face}`)) ??
      (!entry.token && cast && !defended
        ? request.legalActions.find((action) =>
            action.description.startsWith('Cast Blossoming Defense'),
          )
        : undefined) ??
      request.legalActions.find((action) => action.type === 'pass') ??
      request.legalActions[0]!;
    if (action.description.startsWith(`Cast ${spell}`)) cast = true;
    if (action.description.startsWith('Cast Blossoming Defense')) defended = true;
    observations.push({
      player: request.decidingPlayer,
      prompt: request.prompt ?? '',
      selected: action.description,
    });
    const slots = action.targets ?? [];
    const target = scenario.engine
      .getState()
      .battlefield.find(
        (permanent) =>
          permanent.name ===
          (action.description.startsWith('Cast Blossoming Defense') ? 'Copy Companion' : face),
      )!;
    return {
      requestId: request.requestId,
      actionId: action.id,
      ...(slots.length > 0
        ? {
            targets: slots.map((slot) => ({
              slot: slot.slot,
              choice: slot.options.includes(target.id) ? target.id : slot.options[0]!,
            })),
          }
        : {}),
    };
  };
  const provider = new ScriptedDecisionProvider(Array.from({ length: 60 }, () => answer));
  for (;;) {
    const step = scenario.engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    scenario.engine.submit(provider.decide(step.request));
  }
  expect(scenario.engine.getResult()?.haltReason).toBeNull();
  expect(cast).toBe(true);
  return { scenario, state: scenario.engine.getState() as EngineState, observations, provider };
}

describe('transformed DFC pinned interpretation prerequisites', () => {
  it('validates exact full Oracle pins and supported interpretation', () => {
    for (const { card, sha256 } of pins.cards) {
      expect(createHash('sha256').update(JSON.stringify(card)).digest('hex')).toBe(sha256);
      const def = interpretCard(card);
      expect(def.modeled, `${card.name}: ${def.unmodeledReasons.join('; ')}`).toBe(true);
    }
  });
});

describe('transformed DFC normal-cast Card Test Lab evidence', () => {
  for (const entry of TRANSFORMED_DFC_CASES) {
    it(`${entry.id} — copies the active face through payment, priority and resolution`, () => {
      const { state, scenario } = run(entry.id);
      const copies = state.battlefield.filter(
        (permanent) =>
          permanent.controllerId === 'P1' &&
          (entry.token
            ? permanent.isToken && permanent.name.startsWith('Brigid,')
            : permanent.name === "Brigid, Doun's Mind"),
      );
      expect(copies).toHaveLength(1);
      const copy = copies[0]!;
      expect(copy.name).toBe(entry.transformed ? "Brigid, Doun's Mind" : "Brigid, Clachan's Heart");
      expect(copy.typeLine).toContain(
        `Creature — Kithkin ${entry.transformed ? 'Soldier' : 'Warrior'}`,
      );
      expect(copy.power).toBe(3);
      expect(copy.toughness).toBe(2);
      expect(copy.oracleText).toContain(
        entry.transformed ? '{T}: Add X {G} or X {W}' : 'create a 1/1 green and white Kithkin',
      );
      expect(copy.oracleText).not.toContain(
        entry.transformed ? 'create a 1/1 green and white Kithkin' : '{T}: Add X {G} or X {W}',
      );
      expect(
        state.battlefield.filter((permanent) => permanent.isToken && permanent.name === 'Kithkin'),
      ).toHaveLength(entry.transformed ? 0 : 1);
      if (!entry.token)
        expect(
          scenario.engine.spectatorState().battlefield.find((permanent) => permanent.id === copy.id)
            ?.keywords,
        ).toContain('haste');
      expect(
        state.battlefield
          .filter(
            (permanent) => permanent.controllerId === 'P1' && permanent.typeLine.includes('Land'),
          )
          .every((land) => land.tapped),
      ).toBe(true);
      if (!entry.token) {
        expect(copy.tapped).toBe(true);
        const companion = scenario.engine
          .spectatorState()
          .battlefield.find((permanent) => permanent.name === 'Copy Companion')!;
        expect(companion.power).toBe(3);
        expect(companion.toughness).toBe(3);
        expect(companion.keywords).toContain('hexproof');
        expect(
          state.players
            .find((player) => player.id === 'P1')!
            .graveyard.some((card) => card.name === 'Blossoming Defense'),
        ).toBe(true);
      }
      const replay = run(entry.id).state;
      expect(replay.eventLog).toEqual(state.eventLog);
    });
  }
});

describe('transformed DFC gameplay provider observations (scripted, separate from correctness)', () => {
  it('brigid-gameplay-scripted-copy-back — selects a legal cast and copy from the production menu', () => {
    const { observations, provider } = run('brigid-viewer-ordinary-copy-back');
    expect(observations.some(({ selected }) => selected.startsWith("Cast Dack's Duplicate"))).toBe(
      true,
    );
    expect(
      observations.some(({ selected }) => selected.startsWith("Copy Brigid, Doun's Mind")),
    ).toBe(true);
    expect(provider.seen.length).toBeGreaterThan(1);
  });
});
