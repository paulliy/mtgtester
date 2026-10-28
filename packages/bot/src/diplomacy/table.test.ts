import type { Deal, DecisionRequest, DecisionResponse, LegalAction, PlayerId } from '@mtg/shared';
import { NO_ATTACK_TARGET } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { attackAction, creature } from './fixtures.test-helpers';
import { describeMessage } from './render';
import { DiplomacyTable, type DiplomacyState } from './table';
import { viewFrom, type World } from './world.test-helpers';
import { withDiplomacy } from './index';

/** P4 leads with a big board; the other three are roughly even. */
function world(): World {
  return {
    order: ['P1', 'P2', 'P3', 'P4'],
    life: { P1: 30, P2: 35, P3: 30, P4: 40 },
    battlefield: [
      creature('P1', 4),
      creature('P2', 5),
      creature('P2', 5),
      creature('P3', 3),
      creature('P4', 7),
      creature('P4', 7),
      creature('P4', 7),
    ],
  };
}

function setup(w = world(), negotiates: (seat: PlayerId) => boolean = () => true) {
  return new DiplomacyTable({
    seed: 'seed',
    seats: w.order,
    viewOf: (seat) => viewFrom(w, seat),
    negotiates,
  });
}

function priority(turn: number, seat: PlayerId, legalActions: LegalAction[] = []): DecisionRequest {
  return {
    requestId: `r${turn}`,
    gameId: 'g',
    turn,
    activePlayer: seat,
    decidingPlayer: seat,
    phase: 'precombatMain',
    step: null,
    decisionType: 'priority',
    prompt: '',
    legalActions,
  };
}

function runTurns(table: DiplomacyTable, w: World, from: number, to: number): void {
  for (let turn = from; turn <= to; turn++) {
    table.beforeDecision(priority(turn, w.order[(turn - 1) % w.order.length]!));
  }
}

describe('DiplomacyTable — negotiation windows (ADR 0035 decisions 18 and 20)', () => {
  it('calls the leader, then lets each active seat make one proposal that is answered at once', () => {
    const w = world();
    const table = setup(w);
    runTurns(table, w, 1, 1);
    const [call, proposal, answer] = table.messages();
    expect(call).toMatchObject({ kind: 'threatCall', from: 'P1', leader: 'P4' });
    expect(proposal).toMatchObject({ kind: 'proposal', from: 'P1' });
    expect(answer).toMatchObject({ kind: 'response', answer: 'accept' });
    expect(table.activeDeals()).toHaveLength(1);
  });

  it('opens a window only once per turn', () => {
    const w = world();
    const table = setup(w);
    runTurns(table, w, 1, 1);
    const count = table.messages().length;
    table.beforeDecision({ ...priority(1, 'P1'), decidingPlayer: 'P2' });
    expect(table.messages()).toHaveLength(count);
  });

  it('negotiates identically for the same seed', () => {
    const lines = () => {
      const w = world();
      const table = setup(w);
      runTurns(table, w, 1, 12);
      return table.messages().map((m) => describeMessage(m));
    };
    expect(lines()).toEqual(lines());
    expect(lines().length).toBeGreaterThan(3);
  });

  it('saves and restores mid-game, then negotiates exactly as if it had never stopped', () => {
    const w = world();
    const original = setup(w);
    runTurns(original, w, 1, 6);
    // Through JSON, as a database round trip would.
    const saved = JSON.parse(JSON.stringify(original.toState())) as DiplomacyState;
    const restored = DiplomacyTable.fromState(
      { seed: 'seed', seats: w.order, viewOf: (seat) => viewFrom(w, seat), negotiates: () => true },
      saved,
    );
    expect(restored.toState()).toEqual(original.toState());
    runTurns(original, w, 7, 20);
    runTurns(restored, w, 7, 20);
    expect(restored.messages()).toEqual(original.messages());
    expect(restored.stats).toEqual(original.stats);
  });

  it('refuses a saved state from another version', () => {
    const w = world();
    const saved = { ...setup(w).toState(), version: 99 } as unknown as DiplomacyState;
    expect(() =>
      DiplomacyTable.fromState(
        { seed: 's', seats: w.order, viewOf: (seat) => viewFrom(w, seat), negotiates: () => true },
        saved,
      ),
    ).toThrow(/version/);
  });

  it('never offers a deal to a seat that does not negotiate', () => {
    const w = world();
    const table = setup(w, (seat) => seat !== 'P3');
    runTurns(table, w, 1, 4);
    const toP3 = table.messages().filter((m) => m.kind === 'proposal' && m.to === 'P3');
    expect(toP3).toEqual([]);
  });

  it('gives both parties their obligations', () => {
    const w = world();
    const table = setup(w);
    runTurns(table, w, 1, 1);
    const [deal] = table.activeDeals();
    for (const party of deal!.parties) {
      const owed = table.playFor(party).obligations();
      expect(owed.length).toBeGreaterThan(0);
      expect(owed.every((a) => a.obligation.by === party && a.dealId === deal!.id)).toBe(true);
    }
  });
});

describe('DiplomacyTable — keeping, breaking and ending deals', () => {
  function withDeal() {
    const w = world();
    const table = setup(w);
    runTurns(table, w, 1, 1);
    const deal = table.activeDeals()[0]!;
    return { w, table, deal };
  }

  it('records a breach when a party attacks the seat it promised to leave alone', () => {
    const { w, table, deal } = withDeal();
    const [a, b] = deal.parties;
    const attacker = w.battlefield.find((p) => p.controller === a)!;
    const action = attackAction([attacker], () => [b, NO_ATTACK_TARGET]);
    const request = { ...priority(1, a, [action]), decisionType: 'declareAttackers' as const };
    const response: DecisionResponse = {
      requestId: request.requestId,
      actionId: action.id,
      targets: [{ slot: 0, choice: b }],
    };
    table.afterDecision(request, response);
    expect(deal.status).toBe('active');
    table.beforeDecision(priority(1, b));
    expect(deal.status).toBe('broken');
    expect(deal.breachedBy).toBe(a);
    expect(table.stats.broken).toBe(1);
    expect(table.messages().at(-1)).toMatchObject({ kind: 'breach', from: a, dealId: deal.id });
    expect(table.playFor(a).obligations()).toEqual([]);
  });

  it('judges only the attack the engine accepted, not one it rejected and asked again', () => {
    const { w, table, deal } = withDeal();
    const [a, b] = deal.parties;
    const attacker = w.battlefield.find((p) => p.controller === a)!;
    const elsewhere = w.order.find((s) => !deal.parties.includes(s))!;
    const action = attackAction([attacker], () => [b, elsewhere, NO_ATTACK_TARGET]);
    const first = { ...priority(1, a, [action]), decisionType: 'declareAttackers' as const };
    table.afterDecision(first, {
      requestId: 'r1',
      actionId: action.id,
      targets: [{ slot: 0, choice: b }],
    });
    const retry: DecisionRequest = {
      ...first,
      requestId: 'r1b',
      presentation: {
        layout: 'attackDeclaration',
        attackDeclaration: { subjects: [], rejection: { violations: [] } },
      },
    };
    table.beforeDecision(retry);
    table.afterDecision(retry, {
      requestId: 'r1b',
      actionId: action.id,
      targets: [{ slot: 0, choice: elsewhere }],
    });
    table.flush();
    expect(deal.status).toBe('active');
    expect(table.stats.broken).toBe(0);
  });

  it('passes the breaker reason through when the bot reports it', () => {
    const { w, table, deal } = withDeal();
    const [a, b] = deal.parties;
    table.playFor(a).reportBreach?.(deal.id, 'lethal');
    const attacker = w.battlefield.find((p) => p.controller === a)!;
    const action = attackAction([attacker], () => [b]);
    table.afterDecision(
      { ...priority(1, a, [action]), decisionType: 'priority' },
      { requestId: 'r1', actionId: action.id, targets: [{ slot: 0, choice: b }] },
    );
    expect(table.messages().at(-1)).toMatchObject({ kind: 'breach', reason: 'lethal' });
  });

  it('marks an attackPlayer promise met once it is delivered', () => {
    const { w, table, deal } = withDeal();
    const owed = deal.obligations.find((o) => o.kind === 'attackPlayer');
    expect(owed).toBeDefined();
    if (owed?.kind !== 'attackPlayer') return;
    const attacker = w.battlefield.find((p) => p.controller === owed.by)!;
    const action = attackAction([attacker], () => [owed.target, NO_ATTACK_TARGET]);
    table.afterDecision(
      { ...priority(2, owed.by, [action]), decisionType: 'declareAttackers' },
      { requestId: 'r2', actionId: action.id, targets: [{ slot: 0, choice: owed.target }] },
    );
    table.flush();
    expect(deal.status).toBe('active');
    expect(
      table
        .playFor(owed.by)
        .obligations()
        .some((a) => a.obligation === owed),
    ).toBe(false);
  });

  function deliverPromise(w: World, table: DiplomacyTable, deal: Deal, turn: number) {
    const owed = deal.obligations.find((o) => o.kind === 'attackPlayer');
    if (owed?.kind !== 'attackPlayer') throw new Error('expected an attackPlayer obligation');
    const attacker = w.battlefield.find((p) => p.controller === owed.by)!;
    const action = attackAction([attacker], () => [owed.target, NO_ATTACK_TARGET]);
    table.afterDecision(
      { ...priority(turn, owed.by, [action]), decisionType: 'declareAttackers' },
      { requestId: `r${turn}`, actionId: action.id, targets: [{ slot: 0, choice: owed.target }] },
    );
    table.flush();
    return owed;
  }

  /** Turns until every party has taken `rounds` turns, plus the one that ends the deal. */
  function runOut(w: World, table: DiplomacyTable, deal: Deal, from: number): number {
    let turn = from;
    for (; turn < from + 20; turn++) {
      table.beforeDecision(priority(turn, w.order[(turn - 1) % w.order.length]!));
      if (deal.status !== 'active') break;
    }
    return turn;
  }

  it('prices new deals against the promises still binding, not ones already kept', () => {
    const { w, table, deal } = withDeal();
    const owed = deal.obligations.find((o) => o.kind === 'attackPlayer')!;
    if (owed.kind !== 'attackPlayer') throw new Error('expected an attackPlayer obligation');
    const other = w.order.find((s) => !deal.parties.includes(s) && s !== owed.target)!;
    const offer: Deal = {
      id: 'probe',
      proposer: owed.by,
      parties: [owed.by, other],
      obligations: [{ kind: 'attackPlayer', by: owed.by, target: owed.target }],
      proposedTurn: 2,
      rounds: 1,
      status: 'proposed',
    };
    // While the first promise is unmet, the same attack is already owed: worth nothing new.
    expect(table.valueFor(other, offer, 2)).toBe(0);
    deliverPromise(w, table, deal, 2);
    // Once kept, a fresh promise to attack that seat is a new commitment again.
    expect(table.valueFor(other, offer, 2)).not.toBe(0);
  });

  it('treats a promised attack skipped with attackers on board as a breach', () => {
    const { w, table, deal } = withDeal();
    const owed = deal.obligations.find((o) => o.kind === 'attackPlayer')!;
    runOut(w, table, deal, 2);
    expect(deal.status).toBe('broken');
    expect(deal.breachedBy).toBe(owed.by);
    expect(table.trustRecord(owed.by).broken).toBe(1);
  });

  it('counts a promised attack skipped on the accepting turn as a breach', () => {
    const w = world();
    // Only P3 answers offers, so no other deal crowds this one out.
    const table = setup(w, (seat) => seat === 'P3');
    runTurns(table, w, 1, 2);
    // P2 promises, on its own turn, to attack the leader this turn, then never declares.
    const outcome = table.offer({
      proposer: 'P2',
      to: 'P3',
      rounds: 1,
      obligations: [
        { kind: 'attackPlayer', by: 'P2', target: 'P4' },
        { kind: 'noAttack', by: 'P3', against: 'P2' },
      ],
    });
    expect(outcome.kind).toBe('accepted');
    if (outcome.kind !== 'accepted') return;
    runTurns(table, w, 3, 4);
    expect(outcome.deal.status).toBe('broken');
    expect(outcome.deal.breachedBy).toBe('P2');
  });

  it('ends a deal void when the promised target is eliminated before the attacker takes its turn', () => {
    const { w, table, deal } = withDeal();
    const owed = deal.obligations.find((o) => o.kind === 'attackPlayer')!;
    if (owed.kind !== 'attackPlayer') throw new Error('expected an attackPlayer obligation');
    expect(owed.by).not.toBe('P1');
    w.life[owed.target] = 0;
    runOut(w, table, deal, 2);
    expect(deal.status).toBe('void');
    expect(table.trustRecord(owed.by).broken).toBe(0);
  });

  it('ends a deal void when the promised target could not legally be attacked', () => {
    const { w, table, deal } = withDeal();
    const owed = deal.obligations.find((o) => o.kind === 'attackPlayer')!;
    if (owed.kind !== 'attackPlayer') throw new Error('expected an attackPlayer obligation');
    const elsewhere = w.order.find((s) => !deal.parties.includes(s) && s !== owed.target)!;
    const attacker = w.battlefield.find((p) => p.controller === owed.by)!;
    // Every declaration the obligor gets offers every target but the promised one.
    const action = attackAction([attacker], () => [elsewhere, NO_ATTACK_TARGET]);
    let turn = 2;
    for (; turn < 20 && deal.status === 'active'; turn++) {
      const active = w.order[(turn - 1) % w.order.length]!;
      table.beforeDecision(priority(turn, active));
      if (active !== owed.by || deal.status !== 'active') continue;
      table.afterDecision(
        { ...priority(turn, owed.by, [action]), decisionType: 'declareAttackers' },
        { requestId: `r${turn}`, actionId: action.id, targets: [{ slot: 0, choice: elsewhere }] },
      );
    }
    expect(deal.status).toBe('void');
    expect(table.trustRecord(owed.by).broken).toBe(0);
  });

  it('still charges an earlier skipped turn when a later turn is excused or repaired', () => {
    for (const later of ['excused', 'repaired'] as const) {
      const w = world();
      let repaired = 0;
      const table = new DiplomacyTable({
        seed: 'seed',
        seats: w.order,
        viewOf: (seat) => viewFrom(w, seat),
        negotiates: () => true,
        repairedAttacks: () => repaired,
      });
      runTurns(table, w, 1, 1);
      const deal = table.activeDeals()[0]!;
      const owed = deal.obligations.find((o) => o.kind === 'attackPlayer')!;
      if (owed.kind !== 'attackPlayer') throw new Error('expected an attackPlayer obligation');
      const elsewhere = w.order.find((s) => !deal.parties.includes(s) && s !== owed.target)!;
      const attacker = w.battlefield.find((p) => p.controller === owed.by)!;
      let obligorTurns = 0;
      for (let turn = 2; turn < 20 && deal.status === 'active'; turn++) {
        const active = w.order[(turn - 1) % w.order.length]!;
        table.beforeDecision(priority(turn, active));
        if (active !== owed.by || deal.status !== 'active') continue;
        // The first turn is skipped with attackers on board; the second is excused or repaired.
        if (obligorTurns++ === 0) continue;
        const choices = later === 'excused' ? [elsewhere] : [owed.target];
        const action = attackAction([attacker], () => [...choices, NO_ATTACK_TARGET]);
        table.afterDecision(
          { ...priority(turn, owed.by, [action]), decisionType: 'declareAttackers' },
          {
            requestId: `r${turn}`,
            actionId: action.id,
            targets: [{ slot: 0, choice: choices[0]! }],
          },
        );
        if (later === 'repaired') repaired++;
        table.flush();
      }
      expect(deal.status, later).toBe('broken');
      expect(deal.breachedBy, later).toBe(owed.by);
    }
  });

  it('ends a deal void when the promised attack could never be made, charging nobody', () => {
    const { w, table, deal } = withDeal();
    const owed = deal.obligations.find((o) => o.kind === 'attackPlayer')!;
    w.battlefield = w.battlefield.filter((p) => p.controller !== owed.by);
    const end = runOut(w, table, deal, 2);
    expect(deal.status).toBe('void');
    expect(table.messages()).toContainEqual({
      kind: 'dealEnded',
      turn: end,
      dealId: deal.id,
      outcome: 'void',
      reason: 'unmet',
    });
    for (const party of deal.parties) {
      expect(table.trustRecord(party)).toEqual({ kept: 0, broken: 0, biggestKept: 0 });
    }
  });

  it('ends a deal kept once both sides had their turns, but earns no trust for free keeping', () => {
    const { w, table, deal } = withDeal();
    deliverPromise(w, table, deal, 2);
    runOut(w, table, deal, 2);
    expect(deal.status).toBe('kept');
    // Attacking the leader was what this seat wanted anyway: keeping that promise cost it nothing.
    for (const party of deal.parties) expect(table.trustRecord(party).kept).toBe(0);
  });

  it('calls a deal off in the open once one side could kill the other', () => {
    const { w, table, deal } = withDeal();
    const spared = deal.obligations.find((o) => o.kind === 'noAttack')!;
    // The spared seat drops to 1 life, and a second attacker gets past its one blocker.
    if (spared.kind !== 'noAttack') throw new Error('expected a noAttack obligation');
    w.life[spared.against] = 1;
    w.battlefield.push(creature(spared.by, 1));
    runTurns(table, w, 2, 2);
    expect(deal.status).toBe('void');
    expect(table.messages()).toContainEqual(
      expect.objectContaining({ kind: 'dealEnded', dealId: deal.id, reason: 'lethal' }),
    );
  });

  it('keeps what was said: a logged proposal does not change when the deal does', () => {
    const { table } = withDeal();
    const proposal = table.messages().find((m) => m.kind === 'proposal');
    expect(proposal?.kind === 'proposal' && proposal.deal.status).toBe('proposed');
  });

  it('does not judge an attack declaration the engine repaired', () => {
    const w = world();
    let repaired = 0;
    const table = new DiplomacyTable({
      seed: 'seed',
      seats: w.order,
      viewOf: (seat) => viewFrom(w, seat),
      negotiates: () => true,
      repairedAttacks: () => repaired,
    });
    runTurns(table, w, 1, 1);
    const deal = table.activeDeals()[0]!;
    const [a, b] = deal.parties;
    const attacker = w.battlefield.find((p) => p.controller === a)!;
    const action = attackAction([attacker], () => [b, NO_ATTACK_TARGET]);
    table.afterDecision(
      { ...priority(1, a, [action]), decisionType: 'declareAttackers' },
      { requestId: 'r1', actionId: action.id, targets: [{ slot: 0, choice: b }] },
    );
    repaired++;
    table.flush();
    expect(deal.status).toBe('active');
  });

  it('does not charge a promised attack the engine repaired as one the seat skipped', () => {
    const w = world();
    let repaired = 0;
    const table = new DiplomacyTable({
      seed: 'seed',
      seats: w.order,
      viewOf: (seat) => viewFrom(w, seat),
      negotiates: () => true,
      repairedAttacks: () => repaired,
    });
    runTurns(table, w, 1, 1);
    const deal = table.activeDeals()[0]!;
    const owed = deal.obligations.find((o) => o.kind === 'attackPlayer')!;
    if (owed.kind !== 'attackPlayer') throw new Error('expected an attackPlayer obligation');
    const attacker = w.battlefield.find((p) => p.controller === owed.by)!;
    const action = attackAction([attacker], () => [owed.target, NO_ATTACK_TARGET]);
    // Every declaration the obligor makes is repaired by the engine after two rejections.
    for (let turn = 2; turn < 20 && deal.status === 'active'; turn++) {
      const active = w.order[(turn - 1) % w.order.length]!;
      table.beforeDecision(priority(turn, active));
      if (active !== owed.by || deal.status !== 'active') continue;
      table.afterDecision(
        { ...priority(turn, owed.by, [action]), decisionType: 'declareAttackers' },
        { requestId: `r${turn}`, actionId: action.id, targets: [{ slot: 0, choice: owed.target }] },
      );
      repaired++;
      table.flush();
    }
    expect(deal.status).toBe('void');
    expect(table.trustRecord(owed.by).broken).toBe(0);
  });

  it('frees the other party when one becomes the leader, but holds the leader to its word', () => {
    const { w, table, deal } = withDeal();
    const riser = deal.parties[0];
    const other = deal.parties[1];
    w.battlefield.push(creature(riser, 12), creature(riser, 12), creature(riser, 12));
    runTurns(table, w, 2, 2);
    expect(table.messages()).toContainEqual({
      kind: 'released',
      turn: 2,
      dealId: deal.id,
      seat: other,
      reason: 'leader',
    });
    // Released from this deal (a released seat is free to make others).
    expect(
      table
        .playFor(other)
        .obligations()
        .filter((a) => a.dealId === deal.id),
    ).toEqual([]);
    expect(
      table
        .playFor(riser)
        .obligations()
        .filter((a) => a.dealId === deal.id).length,
    ).toBeGreaterThan(0);
  });

  it('ends a deal void, not broken, when a seat answers a protected seat that took the lead', () => {
    const w = world();
    const table = setup(w);
    runTurns(table, w, 1, 1);
    table.beforeDecision(priority(2, 'P2'));
    const outcome = table.offer({
      proposer: 'P2',
      to: 'P3',
      rounds: 1,
      obligations: [
        { kind: 'noTarget', by: 'P2', against: 'P3' },
        { kind: 'noTarget', by: 'P3', against: 'P2' },
      ],
    });
    expect(outcome.kind).toBe('accepted');
    if (outcome.kind !== 'accepted') return;
    // P3 dumps a huge board mid-turn; P2 answers it with removal before any window reruns.
    const bomb = creature('P3', 20);
    w.battlefield.push(bomb, creature('P3', 20), creature('P3', 20));
    const removal: LegalAction = {
      id: 3,
      type: 'castSpell',
      description: 'Cast Removal',
      targets: [{ slot: 0, options: [bomb.id] }],
    };
    table.afterDecision(priority(2, 'P2', [removal]), {
      requestId: 'r2',
      actionId: 3,
      targets: [{ slot: 0, choice: bomb.id }],
    });
    expect(outcome.deal.status).toBe('void');
    expect(table.trustRecord('P2').broken).toBe(0);
    expect(table.messages()).toContainEqual(
      expect.objectContaining({
        kind: 'dealEnded',
        dealId: outcome.deal.id,
        reason: 'selfDefense',
      }),
    );
  });

  it('limits every proposer: one offer a turn, valid terms only', () => {
    const w = world();
    const table = setup(w);
    runTurns(table, w, 1, 1);
    const base = { proposer: 'P2', to: 'P4', rounds: 1 };
    const padded = table.offer({
      ...base,
      obligations: [
        { kind: 'noAttack', by: 'P2', against: 'P4' },
        { kind: 'noAttack', by: 'P2', against: 'P4' },
      ],
    });
    expect(padded).toEqual({ kind: 'refused', reason: 'invalid' });
    const first = table.offer({
      ...base,
      obligations: [{ kind: 'noAttack', by: 'P4', against: 'P2' }],
    });
    expect(first.kind).not.toBe('refused');
    const second = table.offer({
      ...base,
      obligations: [{ kind: 'noAttack', by: 'P2', against: 'P4' }],
    });
    expect(second).toEqual({ kind: 'refused', reason: 'rateLimited' });
  });

  it('takes the turn from the table, never from the caller', () => {
    const w = world();
    const table = setup(w);
    // Before any window opens there is no turn to offer in.
    const early = table.offer({
      proposer: 'P2',
      to: 'P4',
      rounds: 1,
      obligations: [{ kind: 'noAttack', by: 'P4', against: 'P2' }],
    });
    expect(early).toEqual({ kind: 'refused', reason: 'invalid' });
    runTurns(table, w, 1, 9);
    const outcome = table.offer({
      proposer: 'P2',
      to: 'P4',
      rounds: 1,
      obligations: [{ kind: 'noAttack', by: 'P4', against: 'P2' }],
    });
    expect(outcome.kind).not.toBe('refused');
    const proposal = table
      .messages()
      .filter((m) => m.kind === 'proposal')
      .at(-1);
    expect(proposal?.turn).toBe(9);
  });

  it('refuses offers to a seat that does not negotiate', () => {
    const w = world();
    const table = setup(w, (seat) => seat !== 'P4');
    runTurns(table, w, 1, 1);
    const outcome = table.offer({
      proposer: 'P2',
      to: 'P4',
      rounds: 1,
      obligations: [{ kind: 'noAttack', by: 'P4', against: 'P2' }],
    });
    expect(outcome).toEqual({ kind: 'refused', reason: 'notNegotiating' });
  });

  it('routes a provider through the table with withDiplomacy', () => {
    const w = world();
    const table = setup(w);
    const seen: string[] = [];
    const provider = withDiplomacy(table, {
      decide: (r: DecisionRequest) => {
        seen.push(r.requestId);
        return { requestId: r.requestId, actionId: 0 };
      },
    });
    provider.decide(priority(1, 'P1', [{ id: 0, type: 'pass', description: 'Pass' }]));
    expect(seen).toEqual(['r1']);
    expect(table.messages().length).toBeGreaterThan(0);
  });
});
