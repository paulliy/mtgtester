import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  WHITE_BLACK_SPELL_SCENARIO_IDS,
  whiteBlackControlSpellScenario,
} from './white-black-control-spell-scenarios';

const fixture = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/white-black-control-oracle.json', 'utf8'),
) as { cards: { sha256: string; card: { name: string } }[] };

const expectedPins = {
  "Imp's Mischief": 'ff07c155d9e445bf1175adebbfa3860a5c1efa0b21f705535e777b680797f890',
  'Restoration Magic': 'fe14aacd1b134c4f90f994409eb6d0a6852d23b46a9f486af258de9093058d22',
} as const;

interface RunResult {
  scenario: ReturnType<typeof whiteBlackControlSpellScenario>;
  decisions: Array<{ player: string; action: string; targets: string[] }>;
  ended: boolean;
}

function run(id: string): RunResult {
  const scenario = whiteBlackControlSpellScenario(id, `server-test-${id}` as never);
  const engine = scenario.engine;
  const decisions: RunResult['decisions'] = [];
  const name = scenario.metadata.title.split(':')[0]!;
  const isImp = name === "Imp's Mischief";
  let sourceCast = false;
  let redirected = false;
  let ended = false;

  const objectId = (objectName: string): string | undefined => {
    const state = engine.getState();
    return (
      state.battlefield.find((permanent) => permanent.name === objectName)?.id ??
      state.stack.find((item) => item.description === objectName)?.id
    );
  };

  for (let index = 0; index < 160; index += 1) {
    const step = engine.advance();
    if (step.kind === 'continue') continue;
    if (step.kind === 'gameOver') {
      expect(step.result).toMatchObject({ winnerSeat: null, halted: false });
      ended = true;
      break;
    }

    const request = step.request;
    let action = undefined;
    let preferredTarget: string | undefined;

    if (
      isImp &&
      request.decidingPlayer === 'P2' &&
      request.activePlayer === 'P2' &&
      request.phase === 'precombatMain' &&
      request.decisionType === 'priority'
    ) {
      action = request.legalActions.find(
        (candidate) =>
          candidate.type === 'castSpell' &&
          candidate.description.startsWith('Cast Lab Prepared Growth Spell'),
      );
      if (action !== undefined) preferredTarget = objectId('Lab P2 Growth Target');
    }

    if (
      request.decidingPlayer === 'P1' &&
      request.phase === 'precombatMain' &&
      request.decisionType === 'priority' &&
      !sourceCast
    ) {
      action = request.legalActions.find(
        (candidate) =>
          candidate.type === 'castSpell' &&
          candidate.description.startsWith(`Cast ${name}`) &&
          (!name.includes('Restoration') ||
            candidate.description.includes(
              id.endsWith('-cure') ? 'Cure' : id.endsWith('-curaga') ? 'Curaga' : 'Cura',
            )),
      );
      if (action !== undefined) {
        sourceCast = true;
        preferredTarget = isImp
          ? objectId('Lab Prepared Growth Spell')
          : objectId('Lab P1 Cura Target');
      }
    }

    if (
      isImp &&
      sourceCast &&
      request.decidingPlayer === 'P1' &&
      request.decisionType !== 'priority' &&
      !redirected
    ) {
      const redirectTarget = objectId('Lab P1 Redirect Target');
      const redirectChoice = request.legalActions.find((candidate) =>
        candidate.targets?.some((slot) => slot.options.includes(redirectTarget ?? '')),
      );
      if (redirectChoice !== undefined) {
        action = redirectChoice;
        preferredTarget = redirectTarget;
        redirected = true;
      }
    }

    action ??= request.legalActions.find((candidate) => candidate.type === 'pass');
    action ??= request.legalActions[0];
    expect(action, `missing legal action for ${request.decidingPlayer}`).toBeDefined();
    const targets = (action!.targets ?? []).map((slot) => {
      const preferred = preferredTarget;
      const choice =
        preferred !== undefined && slot.options.includes(preferred) ? preferred : slot.options[0];
      expect(choice, `missing choice for target slot ${slot.slot}`).toBeDefined();
      return { slot: slot.slot, choice: choice! };
    });
    decisions.push({
      player: request.decidingPlayer,
      action: action!.description,
      targets: targets.map((target) => target.choice),
    });
    engine.submit({
      requestId: request.requestId,
      actionId: action!.id,
      ...(targets.length > 0 ? { targets } : {}),
    });
  }

  expect(ended).toBe(true);
  expect(sourceCast).toBe(true);
  expect(decisions.some((decision) => decision.action.startsWith(`Cast ${name}`))).toBe(true);
  if (isImp) {
    const changedTarget = engine
      .getState()
      .eventLog.some((event) => event.type === 'spellTargetChanged');
    expect(redirected || changedTarget).toBe(true);
  }
  return { scenario, decisions, ended };
}

describe('white-black-control spell prepared scenarios', () => {
  it.each(WHITE_BLACK_SPELL_SCENARIO_IDS)(
    '%s uses its exact Oracle pin and resolves the normal cast path deterministically',
    (id) => {
      const first = run(id);
      const replay = run(id);
      const name = first.scenario.metadata.title.split(':')[0]!;
      const expected = expectedPins[name as keyof typeof expectedPins];
      expect(expected).toBeDefined();
      expect(fixture.cards.find((entry) => entry.card.name === name)?.sha256).toBe(expected);
      expect(first.scenario.metadata.oracleSha256).toBe(expected);
      expect(first.scenario.metadata.clauseIds).toHaveLength(name === 'Restoration Magic' ? 2 : 1);
      expect(first.decisions).toEqual(replay.decisions);
      const digest = createHash('sha256')
        .update(JSON.stringify(first.scenario.engine.getState().eventLog))
        .digest('hex');
      const replayDigest = createHash('sha256')
        .update(JSON.stringify(replay.scenario.engine.getState().eventLog))
        .digest('hex');
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
      expect(digest).toBe(replayDigest);

      const state = first.scenario.engine.getState();
      if (name === "Imp's Mischief") {
        expect(
          state.players.find((player) => player.id === 'P1')?.life,
          JSON.stringify(first.decisions),
        ).toBe(38);
        const targetChange = state.eventLog.find((event) => event.type === 'spellTargetChanged');
        const redirectTargetId = state.battlefield.find(
          (permanent) => permanent.name === 'Lab P1 Redirect Target',
        )?.id;
        expect(targetChange, 'Imp must change the original spell target').toBeDefined();
        expect(targetChange?.payload).toMatchObject({ to: redirectTargetId });
        expect(
          first.scenario.engine
            .view('P1')
            .battlefield.find((permanent) => permanent.name === 'Lab P1 Redirect Target'),
        ).toMatchObject({ power: 3, toughness: 3 });
        expect(
          first.scenario.engine
            .view('P1')
            .battlefield.find((permanent) => permanent.name === 'Lab P2 Growth Target'),
        ).toMatchObject({ power: 2, toughness: 2 });
        expect(
          state.players
            .find((player) => player.id === 'P1')
            ?.graveyard.some((card) => card.name === "Imp's Mischief"),
        ).toBe(true);
      } else {
        expect(
          state.players.find((player) => player.id === 'P1')?.life,
          JSON.stringify(first.decisions),
        ).toBe(id.endsWith('-cure') ? 35 : id.endsWith('-curaga') ? 41 : 38);
        expect(
          first.scenario.engine
            .view('P1')
            .battlefield.find((permanent) => permanent.name === 'Lab P1 Cura Target')?.keywords,
        ).toEqual(expect.arrayContaining(['hexproof', 'indestructible']));
        expect(
          state.players
            .find((player) => player.id === 'P1')
            ?.graveyard.some((card) => card.name === 'Restoration Magic'),
        ).toBe(true);
      }
    },
  );
});
