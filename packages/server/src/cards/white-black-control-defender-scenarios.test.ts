import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NO_BLOCK_TARGET } from '@mtg/shared';
import {
  WHITE_BLACK_DEFENDER_SCENARIO_IDS,
  whiteBlackControlDefenderScenario,
} from './white-black-control-defender-scenarios';

const fixture = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/white-black-control-oracle.json', 'utf8'),
) as { cards: { sha256: string; card: { name: string } }[] };

const expectedPins = {
  'Archon of Absolution': '9bd606953d9c7d2b28966ca403927c18bb825ffbfbac485fc051b9528b23014e',
  'Soul Snare': '994bae03a713184fd5257172464dc1836785328517d213136f2f45d5c4e89855',
  'The Haunt of Hightower': '85b6c7f3a24a701a82b107aa6b27a0a07cc0796d83f3dcc13d7bedfbd6870e31',
} as const;

interface ScenarioRun {
  scenario: ReturnType<typeof whiteBlackControlDefenderScenario>;
  decisions: Array<{ player: string; type: string; action: string; targets: string[] }>;
  finished: boolean;
  cast: boolean;
  activated: boolean;
  targetWalkerId: string | undefined;
}

function run(id: string): ScenarioRun {
  const scenario = whiteBlackControlDefenderScenario(id, `server-test-${id}` as never);
  const engine = scenario.engine;
  const decisions: ScenarioRun['decisions'] = [];
  const sourceName = scenario.metadata.title.split(':')[0]!;
  const isHaunt = sourceName === 'The Haunt of Hightower';
  const isSnare = sourceName === 'Soul Snare';
  const targetWalkerId = scenario.engine
    .getState()
    .battlefield.find(
      (permanent) =>
        permanent.name ===
        (isHaunt ? 'Lab P2 Planeswalker Defender' : 'Lab P1 Planeswalker Defender'),
    )?.id;
  let cast = false;
  let activated = false;
  let finished = false;

  for (let iteration = 0; iteration < 160; iteration += 1) {
    const step = engine.advance();
    if (step.kind === 'continue') continue;
    if (step.kind === 'gameOver') {
      expect(step.result).toMatchObject({ winnerSeat: null, halted: false });
      finished = true;
      break;
    }

    const request = step.request;
    let action = undefined;
    let targetChoices: string[] = [];

    if (request.decidingPlayer === 'P1' && request.decisionType === 'priority' && !cast) {
      action = request.legalActions.find(
        (candidate) =>
          candidate.type === 'castSpell' && candidate.description.startsWith(`Cast ${sourceName}`),
      );
      if (action !== undefined) cast = true;
    }

    if (
      isSnare &&
      request.decidingPlayer === 'P1' &&
      request.decisionType === 'priority' &&
      !activated
    ) {
      const activation = request.legalActions.find(
        (candidate) => candidate.type === 'activateAbility',
      );
      if (activation !== undefined) {
        action = activation;
        activated = true;
        const attacker = engine
          .getState()
          .battlefield.find((permanent) => permanent.name === 'Lab P2 Attacking Creature');
        expect(attacker).toBeDefined();
        targetChoices = [attacker!.id];
        for (const slot of action.targets ?? [])
          expect(slot.options, 'Soul Snare must offer the actual attacking creature').toContain(
            attacker!.id,
          );
      }
    }

    if (request.decisionType === 'declareAttackers') {
      const declaration = request.legalActions.find(
        (candidate) => candidate.type === 'attackDeclaration',
      );
      expect(declaration).toBeDefined();
      const subjects = request.presentation?.attackDeclaration?.subjects ?? [];
      const targetName = isHaunt ? 'Lab P2 Planeswalker Defender' : 'Lab P1 Planeswalker Defender';
      const chosen: string[] = [];
      for (const [index, slot] of (declaration!.targets ?? []).entries()) {
        const subject = subjects[index];
        const defender = subject?.defenders.find((candidate) => candidate.name === targetName);
        const defenderId = defender?.defenderId ?? defender?.playerId;
        expect(
          defenderId,
          `${subject?.name} should have the intended planeswalker defender`,
        ).toBeDefined();
        expect(slot.options).toContain(defenderId!);
        chosen.push(defenderId!);
      }
      action = declaration;
      targetChoices = chosen;
    }

    if (request.decisionType === 'declareBlockers') {
      const declaration = request.legalActions.find(
        (candidate) => candidate.type === 'blockDeclaration',
      );
      if (declaration !== undefined) {
        action = declaration;
        targetChoices = (declaration.targets ?? []).map((slot) => {
          expect(slot.options).toContain(NO_BLOCK_TARGET);
          return NO_BLOCK_TARGET;
        });
      }
    }

    if (
      isHaunt &&
      request.decidingPlayer === 'P2' &&
      request.legalActions.some((candidate) => /discard/i.test(candidate.description))
    ) {
      const discard = request.legalActions.find((candidate) =>
        /discard/i.test(candidate.description),
      );
      if (discard !== undefined) {
        action = discard;
        targetChoices = (discard.targets ?? []).flatMap((slot) => {
          const card = slot.options.find((option) => {
            const hand = engine.getState().players.find((player) => player.id === 'P2')?.hand;
            return hand?.some(
              (candidate) => candidate.id === option && candidate.name === 'Plains',
            );
          });
          return card === undefined ? [] : [card];
        });
        for (const slot of discard.targets ?? [])
          if (targetChoices.length > 0) expect(slot.options).toContain(targetChoices[0]!);
      }
    }

    action ??= request.legalActions.find((candidate) => candidate.type === 'pass');
    action ??= request.legalActions[0];
    expect(action, `missing legal action for ${request.decidingPlayer}`).toBeDefined();
    const targets = (action!.targets ?? []).map((slot, index) => {
      const chosen = targetChoices[index];
      const choice =
        chosen !== undefined && slot.options.includes(chosen) ? chosen : slot.options[0]!;
      return { slot: slot.slot, choice };
    });
    decisions.push({
      player: request.decidingPlayer,
      type: action!.type,
      action: action!.description,
      targets: targets.map((target) => target.choice),
    });
    engine.submit({
      requestId: request.requestId,
      actionId: action!.id,
      ...(targets.length > 0 ? { targets } : {}),
    });
  }

  expect(finished).toBe(true);
  expect(cast).toBe(true);
  if (isSnare) expect(activated, JSON.stringify(decisions)).toBe(true);
  return { scenario, decisions, finished, cast, activated, targetWalkerId };
}

describe('white-black-control defender prepared scenarios', () => {
  it.each(WHITE_BLACK_DEFENDER_SCENARIO_IDS)(
    '%s uses its exact Oracle pin and exercises the normal Engine path',
    (id) => {
      const first = run(id);
      const replay = run(id);
      const name = first.scenario.metadata.title.split(':')[0]!;
      const expected = expectedPins[name as keyof typeof expectedPins];
      expect(expected).toBeDefined();
      expect(fixture.cards.find((entry) => entry.card.name === name)?.sha256).toBe(expected);
      expect(first.scenario.metadata.oracleSha256).toBe(expected);
      expect(first.scenario.metadata.clauseIds).toHaveLength(
        name === 'The Haunt of Hightower' ? 2 : 1,
      );
      expect(first.scenario.metadata.clauseIds[0]).toContain(
        name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      );
      expect(first.decisions).toEqual(replay.decisions);
      const digest = createHash('sha256')
        .update(JSON.stringify(first.scenario.engine.getState().eventLog))
        .digest('hex');
      const replayDigest = createHash('sha256')
        .update(JSON.stringify(replay.scenario.engine.getState().eventLog))
        .digest('hex');
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
      expect(digest).toBe(replayDigest);
      expect(first.decisions.some((decision) => decision.action.startsWith(`Cast ${name}`))).toBe(
        true,
      );

      const state = first.scenario.engine.getState();
      if (name === 'Archon of Absolution') {
        expect(state.battlefield.some((permanent) => permanent.name === name)).toBe(true);
        expect(
          state.battlefield.filter(
            (permanent) =>
              permanent.name === 'Swamp' && permanent.controllerId === 'P2' && permanent.tapped,
          ),
        ).toHaveLength(1);
        expect(
          state.battlefield.find((permanent) => permanent.name === 'Lab P1 Planeswalker Defender')
            ?.counters['loyalty'],
        ).toBe(1);
        expect(
          first.decisions.some(
            (decision) =>
              decision.type === 'attackDeclaration' &&
              decision.targets.includes(
                state.battlefield.find(
                  (permanent) => permanent.name === 'Lab P1 Planeswalker Defender',
                )!.id,
              ),
          ),
        ).toBe(true);
      } else if (name === 'Soul Snare') {
        expect(first.decisions.some((decision) => decision.type === 'activateAbility')).toBe(true);
        expect(
          state.players
            .find((player) => player.id === 'P1')
            ?.graveyard.some((card) => card.name === name),
        ).toBe(true);
        expect(state.exile.some((card) => card.name === 'Lab P2 Attacking Creature')).toBe(true);
        expect(
          state.battlefield.find((permanent) => permanent.name === 'Lab P1 Planeswalker Defender')
            ?.counters['loyalty'],
        ).toBe(4);
      } else {
        expect(first.decisions.some((decision) => decision.action.startsWith(`Cast ${name}`))).toBe(
          true,
        );
        expect(first.decisions.some((decision) => decision.type === 'attackDeclaration')).toBe(
          true,
        );
        expect(first.targetWalkerId).toBeDefined();
        expect(
          first.decisions.some(
            (decision) =>
              decision.type === 'attackDeclaration' &&
              decision.targets.includes(first.targetWalkerId!),
          ),
        ).toBe(true);
        expect(
          state.players
            .find((player) => player.id === 'P2')
            ?.graveyard.some((card) => card.name === 'Plains'),
        ).toBe(true);
        expect(
          state.battlefield.find((permanent) => permanent.name === name)?.counters['+1/+1'],
          // One counter follows the discard; the second follows the opposing planeswalker entering
          // its owner's graveyard from combat damage.
        ).toBe(2);
        expect(
          state.players
            .find((player) => player.id === 'P2')
            ?.graveyard.some((card) => card.name === 'Lab P2 Planeswalker Defender'),
        ).toBe(true);
      }
    },
  );
});
