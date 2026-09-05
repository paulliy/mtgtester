import { describe, expect, it } from 'vitest';
import type { DecisionRequest, LegalAction, PermanentView, PlayerView } from '@mtg/shared';
import { NO_BLOCK_TARGET } from '@mtg/shared';
import { decide, evaluate } from './evaluate';
import { Rng } from './rng';
import { WEIGHTS } from './weights';

function baseView(overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    seat: 'P1',
    life: 20,
    hand: [],
    deck: [],
    graveyard: [],
    exile: [],
    availableMana: {},
    manaSources: [],
    commanders: [],
    battlefield: [],
    stack: [],
    recentLog: [],
    opponents: [],
    ...overrides,
  };
}

function baseRequest(
  legalActions: LegalAction[],
  overrides: Partial<DecisionRequest> = {},
): DecisionRequest {
  return {
    requestId: 'req-1',
    gameId: 'g1',
    turn: 1,
    activePlayer: 'P1',
    decidingPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    decisionType: 'priority',
    prompt: 'Choose action',
    legalActions,
    ...overrides,
  };
}

const PASS: LegalAction = { id: 0, type: 'pass', description: 'Pass priority' };
const PLAY_LAND: LegalAction = { id: 1, type: 'playLand', description: 'Play Forest' };

describe('evaluate — the suicide-loop fix', () => {
  it('excludes a lethal-or-worse payLife activation entirely, never merely scoring it low', () => {
    const drainSelf: LegalAction = {
      id: 2,
      type: 'activateAbility',
      description: 'Pay 20 life: draw a card',
      data: { abilityCosts: [{ kind: 'payLife', amount: 20 }] },
    };
    const request = baseRequest([PASS, drainSelf]);
    const ranked = evaluate(request, baseView({ life: 20 }));
    expect(ranked.map((r) => r.action.id)).toEqual([0]);
  });

  it('lets a survivable payLife activation outscore pass when it has real upside', () => {
    const payTwo: LegalAction = {
      id: 2,
      type: 'activateAbility',
      description: 'Pay 2 life: draw a card',
      data: { abilityCosts: [{ kind: 'payLife', amount: 2 }] },
    };
    const request = baseRequest([PASS, payTwo]);
    const ranked = evaluate(request, baseView({ life: 20 }));
    expect(ranked[0]!.action.id).toBe(2);
    expect(ranked[0]!.score).toBeGreaterThan(0);
  });

  it('decays a repeated activation until pass overtakes it — the loop dies structurally', () => {
    const payTwo: LegalAction = {
      id: 2,
      type: 'activateAbility',
      description: 'Pay 2 life: draw a card',
      data: { abilityCosts: [{ kind: 'payLife', amount: 2 }] },
    };
    const request = baseRequest([PASS, payTwo]);
    // Only the ability accumulates repeats — `provider.ts`'s `activationKey` returns null for
    // `pass` (it has no source interaction), so pass genuinely stays pinned at 0.
    const repeatsOfAbility = (n: number) => (action: LegalAction) => (action.id === 2 ? n : 0);
    const scoresByRepeat = Array.from({ length: 12 }, (_, n) => {
      const ranked = evaluate(request, baseView({ life: 20 }), {
        repeatCount: repeatsOfAbility(n),
      });
      return ranked.find((r) => r.action.id === 2)!.score;
    });
    // Strictly decreasing...
    for (let i = 1; i < scoresByRepeat.length; i++) {
      expect(scoresByRepeat[i]!).toBeLessThan(scoresByRepeat[i - 1]!);
    }
    // ...and eventually below pass's fixed 0, so pass wins the decision outright.
    const laterRepeat = evaluate(request, baseView({ life: 20 }), {
      repeatCount: repeatsOfAbility(10),
    });
    expect(laterRepeat[0]!.action.id).toBe(0);
  });

  it('stops a FREE repeatable ability too — the hole that let one card take 1,270 activations', () => {
    // A `{0}` ability has no cost for the damper's subtraction to bite on, so decaying the
    // benefit alone left `tempo.activateAbility * 0.6^n` — positive at every n, and forever
    // better than pass. A real game found it: a Hyalopterous Lemure's `{0}: ~ gets -1/-0 and
    // gains flying` stacked 1,270 copies of itself in one priority window and the turn never
    // ended. `repeatActivationPenalty` is what makes the score genuinely cross zero.
    const freeAbility: LegalAction = {
      id: 2,
      type: 'activateAbility',
      description: '{0}: ~ gets -1/-0 and gains flying until end of turn.',
    };
    const request = baseRequest([PASS, freeAbility]);
    const winnerAfter = (n: number): number =>
      evaluate(request, baseView(), {
        repeatCount: (action) => (action.id === 2 ? n : 0),
      })[0]!.action.id;

    expect(winnerAfter(0)).toBe(2); // worth doing once
    const stops = Array.from({ length: 40 }, (_, n) => n).find((n) => winnerAfter(n) === 0);
    expect(stops).toBeDefined();
    expect(stops!).toBeLessThan(10); // and bounded, not merely eventually
  });
});

describe('evaluate — pass is a baseline, not a magnet', () => {
  it('prefers a real development play (playLand) over pass on an empty board', () => {
    const request = baseRequest([PASS, PLAY_LAND]);
    const ranked = evaluate(request, baseView());
    expect(ranked[0]!.action.id).toBe(1);
  });

  it('prefers a free castSpell over pass', () => {
    const castGrizzlyBears: LegalAction = {
      id: 2,
      type: 'castSpell',
      description: 'Cast Grizzly Bears',
    };
    const request = baseRequest([PASS, castGrizzlyBears]);
    const ranked = evaluate(request, baseView());
    expect(ranked[0]!.action.id).toBe(2);
  });

  it('lets a costly-enough action lose to pass on its own arithmetic, without a special rule', () => {
    const expensiveSacrifice: LegalAction = {
      id: 2,
      type: 'activateAbility',
      description: 'Sacrifice two creatures: scry 1',
      data: { abilityCosts: [{ kind: 'sacrificeOther', count: 2 }] },
    };
    const request = baseRequest([PASS, expensiveSacrifice]);
    const ranked = evaluate(request, baseView());
    expect(ranked[0]!.action.id).toBe(0);
  });
});

describe('decide', () => {
  it('is deterministic given the same seed', () => {
    const request = baseRequest([PASS, PLAY_LAND]);
    const view = baseView();
    const a = decide(request, view, new Rng('seed-1'));
    const b = decide(request, view, new Rng('seed-1'));
    expect(a.actionId).toBe(b.actionId);
  });

  it('fills in first-legal targets for the chosen action', () => {
    const targeted: LegalAction = {
      id: 2,
      type: 'castSpell',
      description: 'Cast Lightning Bolt',
      targets: [{ slot: 0, options: ['perm-1', 'perm-2'] }],
    };
    const request = baseRequest([PASS, targeted]);
    const response = decide(request, baseView(), new Rng('seed'));
    expect(response.actionId).toBe(2);
    expect(response.targets).toEqual([{ slot: 0, choice: 'perm-1' }]);
  });

  it('falls back to the first legal action if every candidate is vetoed', () => {
    const onlyLethal: LegalAction = {
      id: 5,
      type: 'activateAbility',
      description: 'Pay 20 life: draw a card',
      data: { abilityCosts: [{ kind: 'payLife', amount: 20 }] },
    };
    const request = baseRequest([onlyLethal]);
    const response = decide(request, baseView({ life: 20 }), new Rng('seed'));
    expect(response.actionId).toBe(5);
    expect(response.note).toContain('veto excluded every candidate');
  });
});

describe('weights sanity', () => {
  it('pass is defined as exactly zero', () => {
    expect(WEIGHTS.passBaseline).toBe(0);
  });
});

function perm(id: string, power: number, toughness: number): PermanentView {
  return { id, controller: 'P2', name: id, power, toughness, tapped: false, status: [] };
}

/**
 * These fixtures never put the deciding seat's own blocker on the battlefield, so ADR 0024 Phase
 * 7b's search declines on every one of them and `decide` falls back to the Phase 4 heuristic.
 * That is deliberate: what these cases pin down is `staticBlockChoices`, which is still the
 * fallback and still has to behave exactly this way. The search path has its own fixtures, with
 * realistic battlefields, in `combat-search.test.ts` — including the boards where the two
 * deliberately disagree.
 */
describe('decide — blockDeclaration (ADR 0023 Phase 4 heuristic, reached as the 7b fallback)', () => {
  const blockRequest = (
    subjects: { subjectId: string; power: number; toughness: number; mustBlock: boolean }[],
    options: string[][],
  ): DecisionRequest => ({
    requestId: 'req-block',
    gameId: 'g1',
    turn: 5,
    activePlayer: 'P1',
    decidingPlayer: 'P2',
    phase: 'combat',
    step: 'declareBlockers',
    decisionType: 'declareBlockers',
    prompt: 'Declare blockers',
    legalActions: [
      {
        id: 0,
        type: 'blockDeclaration',
        description: 'Declare blockers',
        data: { subjects },
        targets: options.map((opts, i) => ({ slot: i, options: opts })),
      },
    ],
  });

  it('blocks the biggest attacker it can survive, declines the rest', () => {
    const request = blockRequest(
      [{ subjectId: 'blocker', power: 2, toughness: 4, mustBlock: false }],
      [['small', 'big', NO_BLOCK_TARGET]],
    );
    const view = baseView({
      life: 40,
      battlefield: [perm('small', 1, 1), perm('big', 3, 3)],
    });
    const response = decide(request, view, new Rng('seed'));
    // toughness 4 survives the power-3 attacker (3 < 4) — answer the bigger threat.
    expect(response.targets).toEqual([{ slot: 0, choice: 'big' }]);
  });

  it('declines when it would just die for nothing and the defender is not desperate', () => {
    const request = blockRequest(
      [{ subjectId: 'blocker', power: 1, toughness: 1, mustBlock: false }],
      [['big', NO_BLOCK_TARGET]],
    );
    const view = baseView({ life: 40, battlefield: [perm('big', 5, 5)] });
    const response = decide(request, view, new Rng('seed'));
    expect(response.targets).toEqual([{ slot: 0, choice: NO_BLOCK_TARGET }]);
  });

  it('chump-blocks anything once the defending player is dangerously low', () => {
    const request = blockRequest(
      [{ subjectId: 'blocker', power: 1, toughness: 1, mustBlock: false }],
      [['big', NO_BLOCK_TARGET]],
    );
    const view = baseView({
      life: WEIGHTS.dangerousLifeThreshold,
      battlefield: [perm('big', 5, 5)],
    });
    const response = decide(request, view, new Rng('seed'));
    expect(response.targets).toEqual([{ slot: 0, choice: 'big' }]);
  });

  it('a mustBlock subject with no worthwhile trade still blocks — decline is not offered', () => {
    const request = blockRequest(
      [{ subjectId: 'blocker', power: 1, toughness: 1, mustBlock: true }],
      [['big']], // no NO_BLOCK_TARGET — mustBlock
    );
    const view = baseView({ life: 40, battlefield: [perm('big', 5, 5)] });
    const response = decide(request, view, new Rng('seed'));
    expect(response.targets).toEqual([{ slot: 0, choice: 'big' }]);
  });
});

/**
 * Same arrangement as the block fixtures above: no attacker in the view carries a `blockedBy`
 * matching these targets, so `searchDamageSplit` cannot identify the dividing creature, declines,
 * and `staticDamageSplit` answers. See `combat-search.test.ts` for the search path.
 */
describe('decide — combatDamageSplit (ADR 0023 Phase 4, CR 510.1c-d)', () => {
  it('kills blockers cheapest-lethal-first until power runs out, no trample means no leftover to the player', () => {
    const request: DecisionRequest = {
      requestId: 'req-split',
      gameId: 'g1',
      turn: 5,
      activePlayer: 'P1',
      decidingPlayer: 'P1',
      phase: 'combat',
      step: 'combatDamage',
      decisionType: 'assignCombatDamage',
      prompt: 'Divide damage',
      legalActions: [
        { id: 0, type: 'assignDamage', description: 'All to A' },
        { id: 1, type: 'assignDamage', description: 'All to B' },
      ],
      combatDamageSplit: { amount: 5, targets: ['blockerA', 'blockerB'] },
    };
    const view = baseView({ battlefield: [perm('blockerA', 0, 2), perm('blockerB', 0, 3)] });
    const response = decide(request, view, new Rng('seed'));
    // Cheapest (2 toughness) first, then whatever's left (3) onto the second — both die, exactly
    // `amount` assigned, nothing wasted or left over since there's no trample target.
    expect(response.combatDamageSplit).toEqual({ blockerA: 2, blockerB: 3 });
  });

  it('sends leftover power to the defending player once every blocker already has lethal (trample)', () => {
    const request: DecisionRequest = {
      requestId: 'req-split-trample',
      gameId: 'g1',
      turn: 5,
      activePlayer: 'P1',
      decidingPlayer: 'P1',
      phase: 'combat',
      step: 'combatDamage',
      decisionType: 'assignCombatDamage',
      prompt: 'Divide damage',
      legalActions: [{ id: 0, type: 'assignDamage', description: 'All to A' }],
      combatDamageSplit: { amount: 6, targets: ['blockerA', 'P2'] },
    };
    const view = baseView({ battlefield: [perm('blockerA', 0, 2)] });
    const response = decide(request, view, new Rng('seed'));
    expect(response.combatDamageSplit).toEqual({ blockerA: 2, P2: 4 });
  });
});
