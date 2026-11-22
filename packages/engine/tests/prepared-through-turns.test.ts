/**
 * `continue.throughTurns`: after the arranged turn, further full turns through the production turn
 * routine, so a lab position reaches a seat's later turns with every turn in between played whole,
 * combat included (bot-bench's multi-turn strategist cases).
 */
import { describe, expect, it } from 'vitest';
import { NO_ATTACK_TARGET, NO_BLOCK_TARGET, type DecisionRequest } from '@mtg/shared';
import {
  buildCardScenario,
  parseCardScenarioFile,
  type CardScenario,
  type CardScenarioFile,
} from '../src/testing/card-scenario';
import { resolveScenarioCard } from './scenario/runner';

function scenario(extra: Partial<CardScenario>): { file: CardScenarioFile; entry: CardScenario } {
  const entry: CardScenario = {
    id: 'through-turns',
    title: 'Further full turns after the arranged one',
    clauses: [],
    instructions: [],
    expectedOutcome: 'each seat takes a whole turn, P1 its next one',
    turn: { player: 'P1', phase: 'precombatMain', number: 5 },
    seats: {
      P1: { battlefield: ['Arbor Elf', 'Forest'] },
      P2: { battlefield: ['Arbor Elf', 'Forest'] },
      P3: { battlefield: ['Forest'] },
      P4: { battlefield: ['Plains'] },
    },
    script: [],
    expect: [],
    ...extra,
  };
  const file = parseCardScenarioFile(
    { schemaVersion: 1, card: 'Arbor Elf', scenarios: [entry] },
    'through-turns',
  );
  return { file, entry: file.scenarios[0]! };
}

/** Holds still: passes, attacks with nothing, blocks with nothing, else the first option. */
function still(request: DecisionRequest) {
  const action =
    request.legalActions.find((candidate) => candidate.type === 'pass') ?? request.legalActions[0]!;
  const targets = (action.targets ?? []).map((slot) => ({
    slot: slot.slot,
    choice:
      slot.options.find((option) => option === NO_ATTACK_TARGET || option === NO_BLOCK_TARGET) ??
      (slot.options[0] as string),
  }));
  return {
    requestId: request.requestId,
    actionId: action.id,
    ...(targets.length > 0 && { targets }),
  };
}

function play(extra: Partial<CardScenario>) {
  const { file, entry } = scenario(extra);
  const { engine } = buildCardScenario(file, entry, resolveScenarioCard, {
    gameId: 'through-turns',
    strictInvariants: true,
  });
  const attackersBy = new Set<string>();
  for (let count = 0; count < 2000; count++) {
    const step = engine.advance();
    if (step.kind === 'gameOver') return { engine, attackersBy, result: step.result };
    if (step.kind === 'continue') continue;
    if (step.request.decisionType === 'declareAttackers')
      attackersBy.add(step.request.decidingPlayer);
    engine.submit(still(step.request));
  }
  throw new Error('no end');
}

const fullTurn = { throughCombat: true, toPostcombatMain: true, toEndStep: true } as const;

describe('continue.throughTurns', () => {
  it("plays each further turn whole, to the arranged player's next turn", () => {
    const { engine, attackersBy, result } = play({ continue: { ...fullTurn, throughTurns: 4 } });
    const ends = engine
      .getState()
      .eventLog.filter((event) => event.type === 'turnEnd')
      .map((event) => event.payload as { turn: number; player: string })
      .map((payload) => `${payload.turn}:${payload.player}`);
    expect(ends).toEqual(['5:P1', '6:P2', '7:P3', '8:P4', '9:P1']);
    expect(result.turnCount).toBe(9);
    // Combat ran on the turns in between, not only on the arranged one.
    expect(attackersBy.has('P2')).toBe(true);
  });

  it('refuses a count out of range and a second continuation', () => {
    expect(() => play({ continue: { ...fullTurn, throughTurns: 13 } })).toThrow(
      /one to twelve further turns/,
    );
    expect(() =>
      play({ continue: { ...fullTurn, throughTurns: 2, throughNextTurn: true } }),
    ).toThrow(/choose one next-turn continuation/);
    expect(() => play({ continue: { throughCombat: true, throughTurns: 2 } })).toThrow(
      /requires combat, postcombat main, and end-step/,
    );
  });
});
