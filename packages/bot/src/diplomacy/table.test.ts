import type { DecisionRequest, DecisionResponse, LegalAction, PlayerId } from '@mtg/shared';
import { NO_ATTACK_TARGET } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { attackAction, creature } from './fixtures.test-helpers';
import { describeMessage } from './render';
import { DiplomacyTable } from './table';
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

describe('DiplomacyTable — negotiation windows (ADR 0031 decisions 18 and 20)', () => {
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

  it('ends a deal as kept after its last turn', () => {
    const { w, table, deal } = withDeal();
    runTurns(table, w, 2, deal.untilTurn! + 1);
    expect(deal.status).toBe('kept');
    expect(table.messages()).toContainEqual({
      kind: 'dealEnded',
      turn: deal.untilTurn! + 1,
      dealId: deal.id,
      outcome: 'kept',
    });
  });

  it('voids a deal when one of its parties becomes the leader', () => {
    const { w, table, deal } = withDeal();
    const riser = deal.parties[0];
    w.battlefield.push(creature(riser, 12), creature(riser, 12), creature(riser, 12));
    runTurns(table, w, 2, 2);
    expect(deal.status).toBe('void');
    expect(table.stats.voided).toBe(1);
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
