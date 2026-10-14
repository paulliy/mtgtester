import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import {
  WHITE_BLACK_KEYWORD_SCENARIO_IDS,
  whiteBlackControlKeywordScenario,
} from './white-black-control-keyword-scenarios';

const pins = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/white-black-control-oracle.json', 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };

async function run(id: string) {
  const scenario = whiteBlackControlKeywordScenario(id, `keyword-contract-${id}`);
  let ended = false;
  let blockRejections = 0;
  for (let index = 0; index < 200; index++) {
    const step = scenario.engine.advance();
    if (step.kind === 'continue') continue;
    if (step.kind === 'gameOver') {
      ended = true;
      break;
    }
    const request = step.request;
    if (request.presentation?.blockDeclaration?.rejection !== undefined) blockRejections++;
    const provider = scenario.decisionProviderOverrides?.[request.decidingPlayer];
    if (provider !== undefined) {
      scenario.engine.submit(await provider.decide(request));
      continue;
    }
    const action =
      request.legalActions.find((candidate) => candidate.type === 'attackDeclaration') ??
      request.legalActions.find((candidate) => candidate.type === 'pass') ??
      request.legalActions[0]!;
    const targets = (action.targets ?? []).map((slot) => ({
      slot: slot.slot,
      choice: slot.options.includes('P2') ? 'P2' : slot.options[0]!,
    }));
    scenario.engine.submit({
      requestId: request.requestId,
      actionId: action.id,
      ...(targets.length ? { targets } : {}),
    });
  }
  expect(ended).toBe(true);
  return { scenario, blockRejections, state: scenario.engine.getState() };
}

describe('white-black-control pinned keyword combat scenarios', () => {
  it.each(WHITE_BLACK_KEYWORD_SCENARIO_IDS)(
    '%s resolves printed combat and rejects forbidden blocking',
    async (id) => {
      const first = await run(id);
      const replay = await run(id);
      const pin = pins.cards.find(
        (entry) => entry.sha256 === first.scenario.metadata.oracleSha256,
      )!;
      expect(pin).toBeDefined();
      const frontName = pin.card.name.split(' // ')[0]!;
      const source = first.state.battlefield.find((permanent) => permanent.name === frontName);
      expect(source).toBeDefined();
      expect(first.state.players.find((player) => player.id === 'P2')?.life).toBe(
        40 - Number(pin.card.power),
      );
      expect(first.state.players.find((player) => player.id === 'P1')?.life).toBe(
        frontName === 'The Haunt of Hightower' ? 38 : 35,
      );
      for (const seat of ['P3', 'P4'])
        expect(first.state.players.find((player) => player.id === seat)?.life).toBe(40);
      expect(
        first.state.battlefield.some(
          (permanent) =>
            permanent.name ===
            (frontName === 'Archon of Absolution'
              ? 'Lab P2 White Flying Blocker'
              : 'Lab P2 Ground Blocker'),
        ),
      ).toBe(true);
      if (frontName === 'Archon of Absolution') {
        expect(
          first.state.battlefield.some(
            (permanent) => permanent.name === 'Lab P1 Colorless Flying Witness',
          ),
        ).toBe(false);
        expect(
          first.state.players
            .find((player) => player.id === 'P1')
            ?.graveyard.some((card) => card.name === 'Lab P1 Colorless Flying Witness'),
        ).toBe(true);
      }
      if (frontName === 'Tergrid, God of Fright') expect(first.blockRejections).toBeGreaterThan(0);
      if (frontName === 'Breena, the Demagogue') {
        expect(source?.counters['+1/+1'] ?? 0).toBe(0);
        expect(first.state.players.find((player) => player.id === 'P1')?.hand).toHaveLength(0);
      }
      expect(first.state.eventLog).toEqual(replay.state.eventLog);
    },
  );
});
