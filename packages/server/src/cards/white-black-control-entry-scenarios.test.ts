import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  WHITE_BLACK_ENTRY_SCENARIO_IDS,
  whiteBlackControlEntryScenario,
} from './white-black-control-entry-scenarios';

interface ScenarioRun {
  hash: string;
  decisions: Array<{ seat: string; action: string; activePlayer: string }>;
  scenario: ReturnType<typeof whiteBlackControlEntryScenario>;
}

function run(id: string): ScenarioRun {
  const scenario = whiteBlackControlEntryScenario(id, `entry-test-${id}` as never);
  const engine = scenario.engine;
  const decisions: ScenarioRun['decisions'] = [];
  let sourceCast = false;
  let p2LandPlayed = false;
  let p2WitnessPlayed = false;
  let finished = false;

  for (let index = 0; index < 160; index += 1) {
    const step = engine.advance();
    if (step.kind === 'continue') continue;
    if (step.kind === 'gameOver') {
      finished = true;
      expect(step.result).toMatchObject({ winnerSeat: null, halted: false });
      break;
    }

    const request = step.request;
    let action = undefined;
    if (
      request.decidingPlayer === 'P1' &&
      (request.activePlayer === 'P1' ||
        (id === 'doorkeeper-thrull-viewer-flash-suppresses-incoming-entry' &&
          request.activePlayer === 'P2')) &&
      request.phase === 'precombatMain' &&
      request.decisionType === 'priority' &&
      !sourceCast
    ) {
      action = request.legalActions.find(
        (candidate) =>
          candidate.type === 'castSpell' &&
          candidate.description.startsWith(`Cast ${scenario.metadata.title.split(':')[0]}`),
      );
      if (action !== undefined) sourceCast = true;
    }

    const p2MainPriority =
      request.decidingPlayer === 'P2' &&
      request.activePlayer === 'P2' &&
      request.phase === 'precombatMain' &&
      request.decisionType === 'priority';
    if (action === undefined && p2MainPriority && !p2WitnessPlayed) {
      const isAuthority = id.startsWith('authority-');
      const isArchon = id.startsWith('archon-');
      if (isAuthority && !p2LandPlayed) {
        action = request.legalActions.find((candidate) =>
          candidate.description.startsWith('Play Lab Opponent Basic Land'),
        );
        if (action !== undefined) p2LandPlayed = true;
      } else if (isArchon) {
        action = request.legalActions.find((candidate) =>
          candidate.description.startsWith('Play Lab Opponent Nonbasic Land'),
        );
        if (action !== undefined) p2WitnessPlayed = true;
      } else {
        const witnessName = isAuthority
          ? 'Lab Opponent Creature'
          : 'Lab Opponent Artifact Creature';
        action = request.legalActions.find(
          (candidate) =>
            candidate.type === 'castSpell' &&
            candidate.description.startsWith(`Cast ${witnessName}`),
        );
        if (action !== undefined) p2WitnessPlayed = true;
      }
    }

    action ??= request.legalActions.find((candidate) => candidate.type === 'pass');
    action ??= request.legalActions[0];
    expect(action).toBeDefined();
    decisions.push({
      seat: request.decidingPlayer,
      action: action!.description,
      activePlayer: request.activePlayer,
    });
    engine.submit({
      requestId: request.requestId,
      actionId: action!.id,
      targets: (action!.targets ?? []).map((slot) => ({
        slot: slot.slot,
        choice: slot.options[0]!,
      })),
    });
  }

  expect(finished).toBe(true);
  expect(sourceCast).toBe(true);
  expect(
    decisions.some(({ action }) =>
      action.startsWith('Cast ' + scenario.metadata.title.split(':')[0]),
    ),
  ).toBe(true);
  const hash = createHash('sha256')
    .update(JSON.stringify(engine.getState().eventLog))
    .digest('hex');
  return { hash, decisions, scenario };
}

describe('white-black control entry viewer scenarios', () => {
  it.each(WHITE_BLACK_ENTRY_SCENARIO_IDS)(
    '%s normally casts its pinned source and resolves the visible entry witness deterministically',
    (id) => {
      const first = run(id);
      const replay = run(id);
      expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(first.hash).toBe(replay.hash);
      expect(first.decisions).toEqual(replay.decisions);
      if (id === 'doorkeeper-thrull-viewer-flash-suppresses-incoming-entry')
        expect(
          first.decisions.find(
            ({ seat, action }) => seat === 'P1' && action.startsWith('Cast Doorkeeper Thrull'),
          )?.activePlayer,
        ).toBe('P2');

      const state = first.scenario.engine.getState();
      const battlefield = state.battlefield;
      const view = first.scenario.engine.view('P1');
      const p1Life = state.players.find((player) => player.id === 'P1')?.life;
      expect(
        battlefield.some(
          (permanent) => permanent.name === first.scenario.metadata.title.split(':')[0],
        ),
      ).toBe(true);

      if (id.startsWith('authority-')) {
        expect(
          battlefield.find((permanent) => permanent.name === 'Lab Opponent Basic Land')?.tapped,
        ).toBe(false);
        expect(
          battlefield.find((permanent) => permanent.name === 'Lab Opponent Creature')?.tapped,
        ).toBe(true);
        expect(p1Life).toBe(41);
      } else if (id.startsWith('archon-')) {
        expect(
          battlefield.find((permanent) => permanent.name === 'Lab Opponent Nonbasic Land')?.tapped,
        ).toBe(true);
        expect(
          view.battlefield.find((permanent) => permanent.name === 'Archon of Emeria')?.keywords,
        ).toContain('flying');
      } else {
        expect(
          battlefield.find((permanent) => permanent.name === 'Lab Opponent Artifact Creature')
            ?.tapped,
        ).toBe(true);
        expect(p1Life).toBe(40);
        if (id.startsWith('doorkeeper-'))
          expect(
            view.battlefield.find((permanent) => permanent.name === 'Doorkeeper Thrull')?.keywords,
          ).toContain('flying');
        if (id.startsWith('hushbringer-'))
          expect(
            view.battlefield.find((permanent) => permanent.name === 'Hushbringer')?.keywords,
          ).toEqual(expect.arrayContaining(['flying', 'lifelink']));
      }
    },
  );
});
