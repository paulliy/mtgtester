import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { interpretCard } from '@mtg/engine';
import type { OracleCard } from '@mtg/shared';
import { createCardTestScenario } from './card-test-scenarios';

const expected = [
  { id: 'marchesa-viewer-first-zone-own', owner: 'P1', returns: true },
  { id: 'marchesa-viewer-first-zone-opponent-owned', owner: 'P2', returns: true },
  { id: 'marchesa-viewer-first-zone-no-counter', owner: 'P1', returns: false },
  { id: 'marchesa-viewer-first-zone-opponent-controlled', owner: 'P2', returns: false },
  { id: 'marchesa-viewer-first-zone-exiled', owner: 'P2', returns: false },
  { id: 'marchesa-viewer-simultaneous-deaths', owner: 'P2', returns: true },
] as const;

describe('pinned Marchesa first-zone real Lab scenarios', () => {
  it('pins fully supported printed Marchesa and both normal responses', () => {
    const fixture = JSON.parse(
      readFileSync('packages/engine/tests/fixtures/zone-change-trigger-oracle.json', 'utf8'),
    ) as { cards: { card: OracleCard; sha256: string }[] };
    const expectedPins: Record<string, string> = {
      'Marchesa, the Black Rose':
        'c73cc966291fc1573d003bbe61f7d57cdb711e2105c70a2958e44b82d9bb83c3',
      Murder: '41e727b47d14f27bed6317531dd9ee6c33e680ec786e7cf9975934380b9f8946',
      'Bojuka Bog': '1204ceae1934ed55c21765dce3247aa82ae4d2dec770774dc6af21f50d9655e5',
    };
    expect(fixture.cards.map(({ card }) => card.name).sort()).toEqual([
      'Bojuka Bog',
      'Marchesa, the Black Rose',
      'Murder',
    ]);
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
  it.each(expected)('$id applies the independently expected owner and zone outcome', (entry) => {
    const scenario = createCardTestScenario(entry.id, `lab-unit-${entry.id}`)!;
    expect(scenario).not.toBeNull();
    const engine = scenario.engine;
    let murder = false;
    let bog = false;
    let ended = false;
    for (let count = 0; count < 100; count++) {
      const step = engine.advance();
      if (step.kind === 'gameOver') {
        ended = true;
        break;
      }
      if (step.kind !== 'decision') continue;
      const request = step.request;
      const main =
        request.decidingPlayer === 'P1' &&
        request.legalActions.find(
          (action) =>
            (!murder &&
              action.type === 'castSpell' &&
              (entry.id === 'marchesa-viewer-simultaneous-deaths'
                ? action.description.includes('Damn') && action.description.includes('Overload')
                : action.description.includes('Murder'))) ||
            (murder &&
              !bog &&
              action.type === 'playLand' &&
              action.description.includes('Bojuka Bog')),
        );
      const action =
        main ||
        request.legalActions.find((action) => action.type === 'pass') ||
        request.legalActions[0]!;
      if (main) {
        if (action.type === 'castSpell') murder = true;
        else bog = true;
      }
      const targets =
        action.targets?.map((slot) => ({
          slot: slot.slot,
          choice:
            slot.options.find(
              (id) =>
                id === 'P2' ||
                engine
                  .getState()
                  .battlefield.some(
                    (object) => object.id === id && object.name === 'First-Zone Witness',
                  ),
            ) ?? slot.options[0]!,
        })) ?? [];
      engine.submit({ requestId: request.requestId, actionId: action.id, targets });
    }
    expect(ended).toBe(true);
    expect(murder).toBe(true);
    expect(bog).toBe(entry.id.endsWith('exiled'));
    const state = engine.getState();
    const returned = state.battlefield.find((object) => object.name === 'First-Zone Witness');
    if (entry.returns) {
      expect(returned).toBeDefined();
      expect(returned!.ownerId).toBe(entry.owner);
      expect(returned!.controllerId).toBe('P1');
      expect(returned!.counters).toEqual({});
      expect(returned).not.toHaveProperty('firstDestinationObjectId');
      expect(returned).not.toHaveProperty('lastKnownFacts');
    } else expect(returned).toBeUndefined();
    const graveyard = state.players.find((player) => player.id === entry.owner)!.graveyard;
    expect(graveyard.some((card) => card.name === 'First-Zone Witness')).toBe(
      !entry.returns && !bog,
    );
    expect(state.exile.some((card) => card.name === 'First-Zone Witness')).toBe(bog);
    expect(
      state.players[0]!.graveyard.filter(
        (card) =>
          card.name === (entry.id === 'marchesa-viewer-simultaneous-deaths' ? 'Damn' : 'Murder'),
      ),
    ).toHaveLength(1);
    if (entry.id === 'marchesa-viewer-simultaneous-deaths') {
      expect(
        state.battlefield.find((card) => card.name === 'Marchesa, the Black Rose')?.counters,
      ).toEqual({});
      expect(state.battlefield.some((card) => card.name === 'Batch No-Counter Witness')).toBe(
        false,
      );
      expect(
        state.players[0]!.graveyard.some((card) => card.name === 'Batch No-Counter Witness'),
      ).toBe(true);
    }
    expect(JSON.stringify(engine.view('P1'))).not.toMatch(
      /firstDestinationObjectId|lastKnownFacts|resolutionObjectFacts|sourceCastState/,
    );
  });
});
