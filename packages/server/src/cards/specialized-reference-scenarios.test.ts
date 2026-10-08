import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { interpretCard } from '@mtg/engine';
import type { OracleCard } from '@mtg/shared';
import { createCardTestScenario } from './card-test-scenarios';

const expected = [
  {
    id: 'madame-null-viewer-pay-life',
    life: 38,
    counters: 2,
    choices: 1,
    response: null,
    present: true,
  },
  {
    id: 'madame-null-viewer-decline',
    life: 40,
    counters: 0,
    choices: 1,
    response: null,
    present: true,
  },
  {
    id: 'madame-null-viewer-unfunded',
    life: 1,
    counters: 0,
    choices: 0,
    response: null,
    present: true,
  },
  {
    id: 'madame-null-viewer-blink',
    life: 36,
    counters: 2,
    choices: 2,
    response: 'Ghostly Flicker',
    present: true,
  },
  {
    id: 'madame-null-viewer-destroyed',
    life: 38,
    counters: 0,
    choices: 1,
    response: 'Murder',
    present: false,
  },
] as const;

describe('pinned Madame Null real Lab event identity and life-payment scenarios', () => {
  it('pins fully supported printed Madame Null and normal instant responses', () => {
    const fixture = JSON.parse(
      readFileSync('packages/engine/tests/fixtures/specialized-reference-oracle.json', 'utf8'),
    ) as { cards: { card: OracleCard; sha256: string }[] };
    expect(fixture.cards.map(({ card }) => card.name).sort()).toEqual([
      'Ghostly Flicker',
      'Madame Null, Power Broker',
      'Murder',
    ]);
    const expectedPins: Record<string, string> = {
      'Madame Null, Power Broker':
        '3fd679e8d950b507d99a4a070fcc8d785e9eaae1ffc54f74694a0460a67e32ed',
      Murder: '41e727b47d14f27bed6317531dd9ee6c33e680ec786e7cf9975934380b9f8946',
      'Ghostly Flicker': '2bd24a1b0ffbe6449fce34f75456b500b8ddb19f7ea5f4fe68bfec3ed193b09c',
    };
    for (const { card, sha256 } of fixture.cards) {
      expect(sha256).toBe(expectedPins[card.name]);
      expect(createHash('sha256').update(JSON.stringify(card)).digest('hex')).toBe(sha256);
      for (const id of [
        card.oracleId,
        `oracle-${card.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')}`,
      ]) {
        const def = interpretCard({ ...card, oracleId: id });
        expect(def.modeled).toBe(true);
        expect(def.unmodeledReasons).toEqual([]);
      }
    }
  });
  it.each(expected)('$id follows normal cast, response, payment and priority', (entry) => {
    const engine = createCardTestScenario(entry.id, `lab-unit-${entry.id}`)!.engine;
    let cast = false;
    let responded = false;
    let choices = 0;
    let ended = false;
    let originalId: string | undefined;
    for (let count = 0; count < 100; count++) {
      const step = engine.advance();
      if (step.kind === 'gameOver') {
        ended = true;
        break;
      }
      if (step.kind !== 'decision') continue;
      const request = step.request;
      const state = engine.getState();
      const witness = state.battlefield.find((card) => card.name === 'Optional-Life Witness');
      originalId ??= witness?.id;
      const castAction =
        request.decidingPlayer === 'P1' &&
        request.legalActions.find(
          (action) =>
            action.type === 'castSpell' &&
            ((!cast && action.description.includes('Optional-Life Witness')) ||
              (entry.response !== null &&
                !responded &&
                witness !== undefined &&
                action.description.includes(entry.response))),
        );
      const pay = request.legalActions.find((action) => action.type === 'payLife');
      const countedTarget = request.legalActions.find(
        (action) =>
          action.type === 'pickTarget' &&
          action.description ===
            (request.prompt.includes('target 1')
              ? 'Target Optional-Life Witness'
              : 'Target Island'),
      );
      if (pay) {
        choices++;
        expect(pay.description).toBe('Pay 2 life and add 2 counter(s)');
      }
      const action =
        castAction ||
        countedTarget ||
        (pay &&
          (entry.id.endsWith('decline')
            ? request.legalActions.find((action) => action.type === 'decline')
            : pay)) ||
        request.legalActions.find((action) => action.type === 'pass') ||
        request.legalActions[0]!;
      if (castAction) {
        if (!cast) cast = true;
        else responded = true;
      }
      const targets =
        action.targets?.map((slot, index) => ({
          slot: slot.slot,
          choice:
            slot.options.find((id) =>
              index === 0
                ? id === witness?.id
                : state.battlefield.some((card) => card.id === id && card.name === 'Island'),
            ) ?? slot.options[0]!,
        })) ?? [];
      engine.submit({ requestId: request.requestId, actionId: action.id, targets });
    }
    expect(ended).toBe(true);
    expect(cast).toBe(true);
    expect(responded).toBe(entry.response !== null);
    expect(choices).toBe(entry.choices);
    const state = engine.getState();
    expect(state.players[0]!.life).toBe(entry.life);
    const witness = state.battlefield.find((card) => card.name === 'Optional-Life Witness');
    expect(witness !== undefined).toBe(entry.present);
    expect(witness?.counters['+1/+1'] ?? 0).toBe(entry.counters);
    if (entry.id.endsWith('blink')) expect(witness!.id).not.toBe(originalId);
    expect(
      state.players[0]!.graveyard.filter((card) => card.name === 'Optional-Life Witness'),
    ).toHaveLength(entry.present ? 0 : 1);
    expect(JSON.stringify(engine.view('P2'))).not.toMatch(
      /resolutionObjectFacts|lastKnownFacts|firstDestinationObjectId|sourceCastState/,
    );
  });
});
