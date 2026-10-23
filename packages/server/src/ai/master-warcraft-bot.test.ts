import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HeuristicDecisionProvider } from '@mtg/bot';
import { ATTACKS_TARGET, NO_ATTACK_TARGET, NO_BLOCK_TARGET } from '@mtg/shared';
import type { DecisionRequest, OracleCard, PlayerId } from '@mtg/shared';
import { Engine } from '../../../engine/src/engine';
import { copies, forest, gameConfig, mountain, oracle } from '../../../engine/tests/fixtures';

const WARCRAFT = (
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../../engine/tests/fixtures/coverage-pr07-oracle.json'),
      'utf8',
    ),
  ) as { cards: { card: OracleCard }[] }
).cards.find((entry) => entry.card.name === 'Master Warcraft')!.card;

const BEAR = (name: string) =>
  oracle({ name, typeLine: 'Creature — Bear', power: '2', toughness: '2' });

/**
 * P1's turn before combat with two Bears (the goaded one must attack a player other than P2),
 * P2 holding Master Warcraft with four lands, and P3 with a Bear that could block.
 */
function game(): Engine {
  return new Engine(
    gameConfig([
      { cards: [BEAR('Lab Bear A'), BEAR('Lab Bear B'), ...copies(8, forest)] },
      { cards: [WARCRAFT, ...copies(8, mountain)] },
      { cards: [BEAR('Lab Bear C'), ...copies(8, forest)] },
    ]),
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 3,
        hand: [{ playerId: 'P2', cardNames: [WARCRAFT.name] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Lab Bear A'], goadedBy: 'P2' },
          { playerId: 'P1', cardNames: ['Lab Bear B'] },
          { playerId: 'P2', cardNames: ['Mountain', 'Mountain', 'Mountain', 'Mountain'] },
          { playerId: 'P3', cardNames: ['Lab Bear C'] },
        ],
        continueThroughCombat: true,
      },
    },
  );
}

/** Drive the game with P2 casting Master Warcraft as soon as it can; `bots` answer the rest. */
function play(engine: Engine, bots: PlayerId[]) {
  const providers = new Map(
    bots.map((seat) => [
      seat,
      new HeuristicDecisionProvider(`master-warcraft-${seat}`, () => engine.view(seat)),
    ]),
  );
  const botAnswers: { request: DecisionRequest; targets: Map<number, string> }[] = [];
  let cast = false;
  for (let steps = 0; steps < 200; steps++) {
    const step = engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind !== 'decision') continue;
    const request = step.request;
    const cast$ = request.legalActions.find(
      (action) => action.type === 'castSpell' && action.description.includes(WARCRAFT.name),
    );
    if (request.decidingPlayer === 'P2' && cast$ !== undefined && !cast) {
      cast = true;
      engine.submit({ requestId: request.requestId, actionId: cast$.id });
      continue;
    }
    const bot = providers.get(request.decidingPlayer);
    if (bot !== undefined) {
      const response = bot.decide(request);
      const action = request.legalActions.find((candidate) => candidate.id === response.actionId);
      // Whatever a bot answers must be on the menu the engine offered, slot by slot.
      expect(action).toBeDefined();
      for (const choice of response.targets ?? [])
        expect(action!.targets![choice.slot]!.options).toContain(choice.choice);
      botAnswers.push({
        request,
        targets: new Map((response.targets ?? []).map((choice) => [choice.slot, choice.choice])),
      });
      engine.submit(response);
      continue;
    }
    // Everyone else: the first defender for an attack, no block, otherwise pass.
    const declare = request.legalActions.find((action) => action.type === 'attackDeclaration');
    if (declare !== undefined)
      engine.submit({
        requestId: request.requestId,
        actionId: declare.id,
        targets: (declare.targets ?? []).map((slot) => ({
          slot: slot.slot,
          choice: slot.options.find((option) => option !== NO_ATTACK_TARGET) ?? NO_ATTACK_TARGET,
        })),
      });
    else {
      const pass = request.legalActions.find((action) => action.type === 'pass');
      engine.submit({
        requestId: request.requestId,
        actionId: (pass ?? request.legalActions[0]!).id,
      });
    }
  }
  return botAnswers;
}

describe('Master Warcraft decisions with a bot seat', () => {
  it('a heuristic bot that cast it chooses the attackers, keeping home what the rules let stay, and the blocks for another player', () => {
    const engine = game();
    const answers = play(engine, ['P2']);
    const set = answers.filter(
      ({ request }) => request.presentation?.attackDeclaration?.mode === 'chooseAttackers',
    );
    expect(set).toHaveLength(1);
    expect(set[0]!.request.decidingPlayer).toBe('P2');
    const names = set[0]!.request.presentation!.attackDeclaration!.subjects.map((s) => s.name);
    // The goaded Bear must attack (no way to stay home); the other can stay, and the bot keeps it home.
    const goaded = names.indexOf('Lab Bear A');
    expect(set[0]!.request.legalActions[0]!.targets![goaded]!.options).toEqual([ATTACKS_TARGET]);
    expect(set[0]!.targets.get(goaded)).toBe(ATTACKS_TARGET);
    expect(set[0]!.targets.get(names.indexOf('Lab Bear B'))).toBe(NO_ATTACK_TARGET);
    // It also answers the block declaration for P3's creature, which is not its own, with no block.
    const blocks = answers.filter(({ request }) => request.decisionType === 'declareBlockers');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.request.presentation?.blockDeclaration?.blockingPlayer).toBe('P3');
    expect([...blocks[0]!.targets.values()]).toEqual([NO_BLOCK_TARGET]);
    // Only the goaded Bear attacked, and nothing blocked it.
    const attacks = engine.getState().eventLog.filter((event) => event.type === 'attack');
    expect(attacks.map((event) => event.payload['attacker'])).toEqual(['Lab Bear A']);
    expect(engine.getState().eventLog.some((event) => event.type === 'block')).toBe(false);
    expect(engine.getResult()?.haltReason ?? null).toBeNull();
  });

  it('a heuristic bot that is the active player assigns what each chosen creature attacks, legally', () => {
    const engine = game();
    // P2 (scripted, not a bot) chooses both Bears to attack: the engine then asks P1, a bot.
    const providers = new HeuristicDecisionProvider('master-warcraft-P1', () => engine.view('P1'));
    let cast = false;
    const assigned: DecisionRequest[] = [];
    for (let steps = 0; steps < 200; steps++) {
      const step = engine.advance();
      if (step.kind === 'gameOver') break;
      if (step.kind !== 'decision') continue;
      const request = step.request;
      const warcraft = request.legalActions.find(
        (action) => action.type === 'castSpell' && action.description.includes(WARCRAFT.name),
      );
      if (request.decidingPlayer === 'P2' && warcraft !== undefined && !cast) {
        cast = true;
        engine.submit({ requestId: request.requestId, actionId: warcraft.id });
        continue;
      }
      const attack = request.presentation?.attackDeclaration;
      if (attack?.mode === 'chooseAttackers') {
        const action = request.legalActions[0]!;
        engine.submit({
          requestId: request.requestId,
          actionId: action.id,
          targets: (action.targets ?? []).map((slot) => ({
            slot: slot.slot,
            choice: ATTACKS_TARGET,
          })),
        });
        continue;
      }
      if (request.decidingPlayer === 'P1') {
        const response = providers.decide(request);
        const action = request.legalActions.find(
          (candidate) => candidate.id === response.actionId,
        )!;
        for (const choice of response.targets ?? [])
          expect(action.targets![choice.slot]!.options).toContain(choice.choice);
        if (attack?.mode === 'assignChosen') assigned.push(request);
        engine.submit(response);
        continue;
      }
      const pass = request.legalActions.find((candidate) => candidate.type === 'pass');
      const fallback = pass ?? request.legalActions[0]!;
      engine.submit({
        requestId: request.requestId,
        actionId: fallback.id,
        targets: (fallback.targets ?? []).map((slot) => ({
          slot: slot.slot,
          choice: slot.options[0] as string,
        })),
      });
    }
    expect(assigned).toHaveLength(1);
    expect(assigned[0]!.decidingPlayer).toBe('P1');
    expect(assigned[0]!.presentation!.attackDeclaration!.chosenBy).toBe('P2');
    expect(
      assigned[0]!.presentation!.attackDeclaration!.subjects.map((s) => s.name).sort(),
    ).toEqual(['Lab Bear A', 'Lab Bear B']);
    // Both attacked, the goaded one not at its goader.
    const attacks = engine
      .getState()
      .eventLog.filter((event) => event.type === 'attack')
      .map((event) => [event.payload['attacker'], event.payload['defender']]);
    expect(attacks).toHaveLength(2);
    expect(attacks.find(([name]) => name === 'Lab Bear A')![1]).not.toBe('P2');
    expect(engine.getResult()?.haltReason ?? null).toBeNull();
  });
});
