import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HeuristicDecisionProvider } from '@mtg/bot';
import type { DecisionRequest, OracleCard, PlayerId } from '@mtg/shared';
import { Engine } from '../../../engine/src/engine';
import { copies, forest, gameConfig, oracle } from '../../../engine/tests/fixtures';

const FIGHT = (
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../../engine/tests/fixtures/coverage-pr07-oracle.json'),
      'utf8',
    ),
  ) as { cards: { card: OracleCard }[] }
).cards.find((entry) => entry.card.name === 'Fight or Flight')!.card;

const BEAR = (letter: string) =>
  oracle({ name: `Lab Bear ${letter}`, typeLine: 'Creature — Bear', power: '2', toughness: '2' });
const BEARS = ['A', 'B', 'C'].map(BEAR);

/** P1 owns Fight or Flight, P2 has three Bears, and it is P2's turn: the whole combat is played. */
function game(): Engine {
  return new Engine(
    gameConfig([
      { cards: [FIGHT, ...copies(8, forest)] },
      { cards: [...BEARS, ...copies(8, forest)] },
    ]),
    {
      preparedScenario: {
        currentTurnPlayer: 'P2',
        phase: 'precombatMain',
        step: null,
        turnNumber: 3,
        hand: [],
        battlefield: [
          { playerId: 'P1', cardNames: [FIGHT.name] },
          { playerId: 'P2', cardNames: BEARS.map((bear) => bear.name) },
        ],
        continueThroughCombat: true,
      },
    },
  );
}

/** Drive the game: `bots` answer through a heuristic provider, everyone else through `script`. */
function play(
  engine: Engine,
  bots: PlayerId[],
  script: (request: DecisionRequest) => number | undefined,
) {
  const providers = new Map(
    bots.map((seat) => [
      seat,
      new HeuristicDecisionProvider(`fight-or-flight-${seat}`, () => engine.view(seat)),
    ]),
  );
  const botAnswers: { request: DecisionRequest; actionId: number }[] = [];
  for (let steps = 0; steps < 120; steps++) {
    const step = engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind !== 'decision') continue;
    const request = step.request;
    const bot = providers.get(request.decidingPlayer);
    if (bot !== undefined) {
      const response = bot.decide(request);
      // Whatever the bot answers must be on the menu the engine offered.
      expect(request.legalActions.some((action) => action.id === response.actionId)).toBe(true);
      botAnswers.push({ request, actionId: response.actionId });
      engine.submit(response);
      continue;
    }
    const chosen = script(request);
    const pass = request.legalActions.find((action) => action.type === 'pass');
    engine.submit({
      requestId: request.requestId,
      actionId: chosen ?? (pass ?? request.legalActions[0]!).id,
    });
  }
  return botAnswers;
}

describe('pile decisions (Fight or Flight) with a bot seat', () => {
  it('a heuristic bot, as the active player, answers the pile choice legally and only the pile it chose attacks', () => {
    const engine = game();
    // P1 puts Bear A in pile 1 and the others in pile 2.
    const answers = play(engine, ['P2'], (request) => {
      const separating = request.prompt.match(/^Put (.*) in a pile\.$/);
      if (separating === null) return undefined;
      const wanted = separating[1] === 'Lab Bear A' ? 'Put it in pile 1' : 'Put it in pile 2';
      return request.legalActions.find((action) => action.description === wanted)!.id;
    });
    const choice = answers.filter(({ request }) => request.prompt.includes('choose a pile'));
    expect(choice).toHaveLength(1);
    expect(choice[0]!.request.decidingPlayer).toBe('P2');
    expect(choice[0]!.request.legalActions.map((action) => action.description)).toEqual([
      'Attack with pile 1: Lab Bear A',
      'Attack with pile 2: Lab Bear B, Lab Bear C',
    ]);
    const pile = choice[0]!.actionId === 0 ? ['Lab Bear A'] : ['Lab Bear B', 'Lab Bear C'];
    const tapped = engine
      .getState()
      .battlefield.filter((perm) => perm.controllerId === 'P2' && perm.tapped)
      .map((perm) => perm.name)
      .sort();
    // The heuristic attacks with everything it may; nothing outside the chosen pile could.
    expect(tapped).toEqual(pile);
    expect(engine.getResult()?.haltReason ?? null).toBeNull();
  });

  it('a heuristic bot, as the enchantment’s controller, puts every creature in one of the two piles', () => {
    const engine = game();
    const answers = play(engine, ['P1'], (request) =>
      request.prompt.includes('choose a pile') ? request.legalActions[0]!.id : undefined,
    );
    const separating = answers.filter(({ request }) => /^Put .* in a pile\.$/.test(request.prompt));
    expect(separating.map(({ request }) => request.decidingPlayer)).toEqual(['P1', 'P1', 'P1']);
    for (const { request } of separating)
      expect(request.legalActions.map((action) => action.description)).toEqual([
        'Put it in pile 1',
        'Put it in pile 2',
      ]);
    expect(engine.getResult()?.haltReason ?? null).toBeNull();
  });
});
