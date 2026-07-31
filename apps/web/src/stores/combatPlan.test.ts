/**
 * `combatPlan` composition and replay (brief — player-experience overhaul, Workstream 5).
 * Pure TS, no DOM — mirrors `game.test.ts`'s conventions. Requests are built to match exactly
 * what `combat.ts`'s `declareAttackers` actually generates (id = index, `noAttack` first, one
 * `attack` per opponent, then the `*Rest` batch shortcuts), so a change to the store's matching
 * logic that would desync from the real engine shape fails here too.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { DecisionRequest, LegalAction } from '@mtg/shared';
import { useCombatPlanStore } from './combatPlan';

const OPPONENTS = ['P2', 'P3'];

/** One `declareAttackers` request for `subjectId`, with `rest` creatures still to come. */
function attackRequest(subjectId: string, rest: string[]): DecisionRequest {
  const legalActions: LegalAction[] = [
    { id: 0, type: 'noAttack', description: `${subjectId} does not attack`, interaction: { kind: 'attack', attackerId: subjectId } },
    ...OPPONENTS.map((opp, i): LegalAction => ({
      id: i + 1,
      type: 'attack',
      description: `${subjectId} attacks ${opp}`,
      interaction: { kind: 'attack', attackerId: subjectId, defenderId: opp },
    })),
  ];
  if (rest.length > 0) {
    legalActions.push({
      id: legalActions.length,
      type: 'noAttackRest',
      description: 'No further attacks',
      interaction: { kind: 'attack', attackerId: subjectId, appliesToRemaining: true },
    });
    for (const opp of OPPONENTS) {
      legalActions.push({
        id: legalActions.length,
        type: 'attackRest',
        description: `All undeclared creatures attack ${opp}`,
        interaction: { kind: 'attack', attackerId: subjectId, defenderId: opp, appliesToRemaining: true },
      });
    }
  }
  return {
    requestId: `req-${subjectId}`,
    gameId: 'g1',
    turn: 3,
    activePlayer: 'P1',
    decidingPlayer: 'P1',
    phase: 'combat',
    step: 'declareAttackers',
    decisionType: 'declareAttackers',
    prompt: `Declare attackers: does ${subjectId} attack?`,
    legalActions,
    presentation: {
      layout: 'combat',
      combat: {
        kind: 'attackers',
        subjectId,
        remaining: rest.map((id) => ({ subjectId: id, optionIds: OPPONENTS })),
      },
    },
  };
}

describe('combatPlan', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('composes without submitting, then replays one submit per subject', () => {
    const store = useCombatPlanStore();
    const req = attackRequest('A', ['B', 'C']);
    store.onRequest(req);
    expect(store.mode).toBe('composing');

    // Nothing submitted while composing.
    expect(store.answerCurrent(req)).toBeNull();

    store.assign('A', 'P2');
    store.assign('B', 'P3');
    // 'C' left unassigned — declines.
    store.confirm();
    expect(store.mode).toBe('replaying');

    const submittedA = store.answerCurrent(req);
    expect(submittedA).toBe(1); // attacks P2
    expect(store.answered.has('A')).toBe(true);

    const reqB = attackRequest('B', ['C']);
    store.onRequest(reqB);
    const submittedB = store.answerCurrent(reqB);
    expect(submittedB).toBe(2); // attacks P3

    const reqC = attackRequest('C', []);
    store.onRequest(reqC);
    const submittedC = store.answerCurrent(reqC);
    expect(submittedC).toBe(0); // noAttack (declined)
  });

  it('collapses an alpha strike (everyone assigned the same defender) into one submit', () => {
    const store = useCombatPlanStore();
    const req = attackRequest('A', ['B', 'C']);
    store.onRequest(req);
    store.assign('A', 'P2');
    store.assign('B', 'P2');
    store.assign('C', 'P2');
    store.confirm();

    const submitted = store.answerCurrent(req);
    // attackRest targeting P2: id 3 (noAttack=0, attack P2=1, attack P3=2, noAttackRest=3, attackRest P2=4)
    const attackRestP2 = req.legalActions.find(
      (a) => a.type === 'attackRest' && a.description.includes('P2'),
    );
    expect(submitted).toBe(attackRestP2!.id);
    expect(store.answered.has('A')).toBe(true);
    expect(store.answered.has('B')).toBe(true);
    expect(store.answered.has('C')).toBe(true);
  });

  it('collapses "no attacks" into one submit via noAttackRest', () => {
    const store = useCombatPlanStore();
    const req = attackRequest('A', ['B', 'C']);
    store.onRequest(req);
    // No assignments at all.
    store.confirm();

    const submitted = store.answerCurrent(req);
    const noAttackRest = req.legalActions.find((a) => a.type === 'noAttackRest');
    expect(submitted).toBe(noAttackRest!.id);
    expect(store.answered.size).toBe(3);
  });

  it('aborts to interrupted, with zero further submits, when the expected option is gone', () => {
    const store = useCombatPlanStore();
    const req = attackRequest('A', ['B']);
    store.onRequest(req);
    store.assign('A', 'P2');
    store.assign('B', 'P3');
    store.confirm();
    expect(store.answerCurrent(req)).toBe(1); // A attacks P2, fine

    // B's real menu no longer offers attacking P3 at all (board changed).
    const reqB: DecisionRequest = {
      ...attackRequest('B', []),
      legalActions: [
        { id: 0, type: 'noAttack', description: 'B does not attack', interaction: { kind: 'attack', attackerId: 'B' } },
        { id: 1, type: 'attack', description: 'B attacks P2', interaction: { kind: 'attack', attackerId: 'B', defenderId: 'P2' } },
      ],
    };
    store.onRequest(reqB);
    expect(store.answerCurrent(reqB)).toBeNull();
    expect(store.mode).toBe('interrupted');
    expect(store.interruptedMessage).not.toBeNull();
  });

  it('never submits during composing, even if answerCurrent is called repeatedly', () => {
    const store = useCombatPlanStore();
    const req = attackRequest('A', []);
    store.onRequest(req);
    expect(store.answerCurrent(req)).toBeNull();
    expect(store.answerCurrent(req)).toBeNull();
    expect(store.mode).toBe('composing');
  });
});
