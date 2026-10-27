import type { DealObligation, LegalAction, PermanentView, PlayerView } from '@mtg/shared';
import { NO_ATTACK_TARGET } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { decide } from '../evaluate';
import { Rng } from '../rng';
import { WEIGHTS } from '../weights';
import { attackAction, creature, opponent, request, view } from './fixtures.test-helpers';
import {
  breachCost,
  complyingTargets,
  planAttackDeclaration,
  targetBreachPenalty,
  type ActiveObligation,
  type BreachReason,
  type DiplomacyPlay,
} from './play';

function dip(
  obligations: DealObligation[],
  startingOpponents = 3,
): DiplomacyPlay & {
  breaches: { dealId: string; reason: BreachReason }[];
} {
  const breaches: { dealId: string; reason: BreachReason }[] = [];
  const active: ActiveObligation[] = obligations.map((obligation, i) => ({
    dealId: `deal-${i + 1}`,
    obligation,
  }));
  return {
    obligations: () => active,
    startingOpponents,
    reportBreach: (dealId, reason) => breaches.push({ dealId, reason }),
    breaches,
  };
}

function everyone(attacker: PermanentView): string[] {
  return ['P2', 'P3', 'P4', NO_ATTACK_TARGET].filter(() => attacker !== undefined);
}

/** P1 attacks with a 4 and a 2. P2 leads on board; P3 is low but out of reach; P4 is even. */
function board(p3Life = 12): { v: PlayerView; attackers: PermanentView[] } {
  const attackers = [creature('P1', 4), creature('P1', 2)];
  const v = view(
    'P1',
    30,
    [opponent('P2', 40), opponent('P3', p3Life), opponent('P4', 30)],
    [...attackers, creature('P2', 8), creature('P2', 8), creature('P2', 8), creature('P4', 3)],
  );
  return { v, attackers };
}

describe('planAttackDeclaration — threat-aware targets (ADR 0031 decision 16)', () => {
  it('attacks the leader rather than the lowest life total when no kill is on', () => {
    const { v, attackers } = board();
    const plan = planAttackDeclaration(attackAction(attackers, everyone), v, dip([]));
    expect(plan.targets.map((t) => t.choice)).toEqual(['P2', 'P2']);
  });

  it('goes for the kill when the attack is lethal', () => {
    const { v, attackers } = board(6);
    const plan = planAttackDeclaration(attackAction(attackers, everyone), v, dip([]));
    expect(plan.targets.map((t) => t.choice)).toEqual(['P3', 'P3']);
  });
});

describe('planAttackDeclaration — keeping and breaking deals (decision 17)', () => {
  it('keeps a truce when breaking it would only move damage around', () => {
    const { v, attackers } = board();
    const d = dip([{ kind: 'noAttack', by: 'P1', against: 'P2' }]);
    const plan = planAttackDeclaration(attackAction(attackers, everyone), v, d);
    expect(plan.targets.some((t) => t.choice === 'P2')).toBe(false);
    expect(plan.breach).toBeUndefined();
    expect(d.breaches).toEqual([]);
  });

  it('breaks a truce for lethal and says so', () => {
    const { v, attackers } = board(6);
    const d = dip([{ kind: 'noAttack', by: 'P1', against: 'P3' }]);
    const plan = planAttackDeclaration(attackAction(attackers, everyone), v, d);
    expect(plan.targets.map((t) => t.choice)).toEqual(['P3', 'P3']);
    expect(plan.breach).toEqual({ dealId: 'deal-1', reason: 'lethal' });
  });

  it('sends its smallest attacker to honor an attackPlayer promise', () => {
    const { v, attackers } = board();
    const d = dip([{ kind: 'attackPlayer', by: 'P1', target: 'P4' }]);
    const plan = planAttackDeclaration(attackAction(attackers, everyone), v, d);
    expect(plan.targets.map((t) => t.choice)).toEqual(['P2', 'P4']);
  });

  it('holds back a creature whose only targets are protected', () => {
    const { v, attackers } = board();
    const d = dip([{ kind: 'noAttack', by: 'P1', against: 'P4' }]);
    const plan = planAttackDeclaration(
      attackAction(attackers, () => ['P4', NO_ATTACK_TARGET]),
      v,
      d,
    );
    expect(plan.targets.map((t) => t.choice)).toEqual([NO_ATTACK_TARGET, NO_ATTACK_TARGET]);
  });

  it('charges less for a breach as opponents are eliminated', () => {
    const { v } = board();
    expect(breachCost(dip([], 3), v)).toBe(WEIGHTS.deals.breakPenalty);
    const late = { ...v, opponents: v.opponents.slice(0, 1) };
    expect(breachCost(dip([], 3), late)).toBeCloseTo(WEIGHTS.deals.breakPenalty / 3);
  });
});

describe('non-combat targets under a deal', () => {
  const theirs = creature('P2', 3);
  const others = creature('P3', 3);
  const v = view('P1', 30, [opponent('P2', 30), opponent('P3', 30)], [theirs, others]);
  const noTarget = dip([{ kind: 'noTarget', by: 'P1', against: 'P2' }]);

  it('picks a complying target when the slot has one', () => {
    const action: LegalAction = {
      id: 2,
      type: 'castSpell',
      description: 'Cast Removal',
      targets: [{ slot: 0, options: [theirs.id, others.id] }],
    };
    expect(complyingTargets(action, v, noTarget)).toEqual([{ slot: 0, choice: others.id }]);
    expect(targetBreachPenalty(action, v, noTarget)).toBe(0);
  });

  it('scores an action that could only break the deal below passing', () => {
    const stuck: LegalAction = {
      id: 2,
      type: 'castSpell',
      description: 'Cast Removal',
      targets: [{ slot: 0, options: [theirs.id] }],
    };
    expect(targetBreachPenalty(stuck, v, noTarget)).toBeGreaterThan(0);
    const pass: LegalAction = { id: 0, type: 'pass', description: 'Pass' };
    const req = request('P1', [pass, stuck]);
    expect(decide(req, v, new Rng('x'), { diplomacy: noTarget }).actionId).toBe(0);
    expect(decide(req, v, new Rng('x')).actionId).toBe(2);
  });
});
