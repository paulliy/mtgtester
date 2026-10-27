import type { DealObligation, LegalAction } from '@mtg/shared';
import { NO_ATTACK_TARGET, NO_BLOCK_TARGET } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { judgeDecision, offeredBreach, ownerLookup, stackLookup } from './compliance';
import {
  attackAction,
  creature,
  opponent,
  planeswalker,
  request,
  view,
} from './fixtures.test-helpers';

const mine = creature('P1', 3);
const theirs = creature('P2', 2);
const walker = planeswalker('P2');
const other = creature('P3', 2);
const v = view('P1', 30, [opponent('P2', 30), opponent('P3', 30)], [mine, theirs, walker, other], {
  stack: [{ id: 's1', controller: 'P2', description: 'Spell', targets: [] }],
});
const ownerOf = ownerLookup(v);
const isStack = stackLookup(v);

const noAttack: DealObligation = { kind: 'noAttack', by: 'P1', against: 'P2' };
const noTarget: DealObligation = { kind: 'noTarget', by: 'P1', against: 'P2' };
const noCounter: DealObligation = { kind: 'noCounter', by: 'P1', against: 'P2' };

function judge(
  o: DealObligation,
  action: LegalAction,
  choices: string[],
  decisionType = 'priority',
) {
  return judgeDecision(
    o,
    request('P1', [action], { decisionType: decisionType as 'priority' }),
    {
      requestId: 'r1',
      actionId: action.id,
      targets: choices.map((choice, slot) => ({ slot, choice })),
    },
    ownerOf,
    isStack,
  );
}

describe('judgeDecision — attacks (ADR 0031 decision 6)', () => {
  const attack = attackAction([mine], () => ['P2', walker.id, 'P3', NO_ATTACK_TARGET]);

  it('flags an attack at the protected seat or its planeswalker', () => {
    expect(judge(noAttack, attack, ['P2'], 'declareAttackers')).toBe('violated');
    expect(judge(noAttack, attack, [walker.id], 'declareAttackers')).toBe('violated');
  });

  it('accepts attacking someone else or not attacking', () => {
    expect(judge(noAttack, attack, ['P3'], 'declareAttackers')).toBe('kept');
    expect(judge(noAttack, attack, [NO_ATTACK_TARGET], 'declareAttackers')).toBe('kept');
  });

  it('excuses a creature that must attack and can only attack the protected seat', () => {
    const forced = attackAction([mine], () => ['P2']);
    expect(judge(noAttack, forced, ['P2'], 'declareAttackers')).toBe('excused');
  });

  it('ignores blocks, other seats and non-attack obligations', () => {
    const block: LegalAction = {
      id: 3,
      type: 'blockDeclaration',
      description: 'Declare blockers',
      targets: [{ slot: 0, options: [theirs.id, NO_BLOCK_TARGET] }],
    };
    expect(judge(noAttack, block, [theirs.id], 'declareBlockers')).toBe('irrelevant');
    expect(judge({ ...noAttack, by: 'P3' }, attack, ['P2'], 'declareAttackers')).toBe('irrelevant');
    expect(judge(noTarget, attack, ['P2'], 'declareAttackers')).toBe('irrelevant');
  });

  it('judges attackPlayer as met, broken, or excused when the target was out of reach', () => {
    const owe: DealObligation = { kind: 'attackPlayer', by: 'P1', target: 'P2' };
    expect(judge(owe, attack, [walker.id], 'declareAttackers')).toBe('kept');
    expect(judge(owe, attack, ['P3'], 'declareAttackers')).toBe('violated');
    const unreachable = attackAction([mine], () => ['P3', NO_ATTACK_TARGET]);
    expect(judge(owe, unreachable, ['P3'], 'declareAttackers')).toBe('excused');
  });
});

describe('judgeDecision — targets', () => {
  const removal: LegalAction = {
    id: 4,
    type: 'castSpell',
    description: 'Cast Removal',
    targets: [{ slot: 0, options: [theirs.id] }],
  };

  it('flags a voluntary spell at the protected seat even with no other target', () => {
    expect(judge(noTarget, removal, [theirs.id])).toBe('violated');
  });

  it('excuses a forced target with no complying option, but not one that had an alternative', () => {
    const trigger: LegalAction = { ...removal, type: 'chooseTargets' };
    expect(judge(noTarget, trigger, [theirs.id], 'chooseTargets')).toBe('excused');
    const choice: LegalAction = {
      ...trigger,
      targets: [{ slot: 0, options: [theirs.id, other.id] }],
    };
    expect(judge(noTarget, choice, [theirs.id], 'chooseTargets')).toBe('violated');
    expect(judge(noTarget, choice, [other.id], 'chooseTargets')).toBe('kept');
  });

  it('limits noCounter to the protected seat spells on the stack', () => {
    const counter: LegalAction = {
      id: 5,
      type: 'castSpell',
      description: 'Cast Counterspell',
      targets: [{ slot: 0, options: ['s1'] }],
    };
    expect(judge(noCounter, counter, ['s1'])).toBe('violated');
    expect(judge(noCounter, removal, [theirs.id])).toBe('kept');
    expect(judge(noTarget, counter, ['s1'])).toBe('violated');
  });
});

describe('attackPlayer needs a real attack, and temptation is recorded', () => {
  const big = creature('P1', 6);
  const token = creature('P1', 1);
  const owe: DealObligation = { kind: 'attackPlayer', by: 'P1', target: 'P2' };

  it('does not count a token attack as keeping the promise', () => {
    const attack = attackAction([big, token], () => ['P2', 'P3', NO_ATTACK_TARGET]);
    expect(judge(owe, attack, ['P3', 'P2'], 'declareAttackers')).toBe('violated');
    expect(judge(owe, attack, ['P2', 'P3'], 'declareAttackers')).toBe('kept');
  });

  it('knows when a decision offered a way to break a promise', () => {
    const attack = attackAction([mine], () => ['P2', 'P3', NO_ATTACK_TARGET]);
    const elsewhere = attackAction([mine], () => ['P3', NO_ATTACK_TARGET]);
    const req = (a: LegalAction) => request('P1', [a], { decisionType: 'declareAttackers' });
    expect(offeredBreach(noAttack, req(attack), ownerOf, isStack)).toBe(true);
    expect(offeredBreach(noAttack, req(elsewhere), ownerOf, isStack)).toBe(false);
  });

  it('protects cards in the protected seat graveyard from targeting', () => {
    const withGrave = view('P1', 30, [
      opponent('P2', 30, { graveyard: [{ id: 'g1', name: 'Dead Thing' }] }),
    ]);
    expect(ownerLookup(withGrave)('g1')).toBe('P2');
  });
});
