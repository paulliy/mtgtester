import { describe, expect, it } from 'vitest';
import type { DecisionRequest } from '@mtg/shared';
import { validateResponse } from './validate';

function fixtureRequest(): DecisionRequest {
  return {
    requestId: 'req-100',
    gameId: 'g1',
    turn: 1,
    activePlayer: 'P1',
    decidingPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    decisionType: 'priority',
    prompt: 'Choose an action',
    legalActions: [
      { id: 0, type: 'pass', description: 'Pass' },
      {
        id: 1,
        type: 'castSpell',
        description: 'Cast Bolt',
        targets: [{ slot: 0, options: ['perm-1', 'perm-2'] }],
      },
    ],
  };
}

/** A 6-power trampler blocked by one creature that needs 1 damage to die, attacking P3. */
function splitRequest(lethal?: Record<string, number>): DecisionRequest {
  return {
    ...fixtureRequest(),
    decisionType: 'assignCombatDamage',
    legalActions: [
      { id: 0, type: 'assignDamage', description: 'All 6 damage to Savannah Lions' },
      { id: 1, type: 'assignDamage', description: 'All 6 damage to P3' },
    ],
    combatDamageSplit: { amount: 6, targets: ['perm-9', 'P3'], ...(lethal && { lethal }) },
  };
}

describe('combat damage split validation', () => {
  const answer = (combatDamageSplit?: Record<string, number>) =>
    validateResponse(
      { requestId: 'req-100', actionId: 1, ...(combatDamageSplit && { combatDamageSplit }) },
      splitRequest({ 'perm-9': 1 }),
    );

  it('accepts lethal to the blocker and the rest to the player', () => {
    expect(answer({ 'perm-9': 1, P3: 5 })).toBeNull();
    expect(answer({ 'perm-9': 6 })).toBeNull();
  });

  it('rejects trample damage to the player before the blocker has lethal', () => {
    // What a model sent in a live benchmark run: the engine applied it as 6 to the blocker.
    const error = answer({ P3: 6 });
    expect(error).toMatch(/"perm-9" needs at least 1/);
    expect(error).toMatch(/at most 5 for "P3"/);
  });

  it('rejects an answer by actionId alone, a wrong total, and an unknown target', () => {
    expect(answer()).toMatch(/answered with "combatDamageSplit"/);
    expect(answer({ 'perm-9': 1, P3: 4 })).toMatch(/sums to 5 but must sum to exactly 6/);
    expect(answer({ 'perm-9': 1, P4: 5 })).toMatch(/"P4", which is not one of the targets/);
    expect(answer({ 'perm-9': 1.5, P3: 4.5 })).toMatch(/whole number/);
  });

  it('checks only shape and total when the request carries no lethal amounts', () => {
    const request = splitRequest();
    const send = (combatDamageSplit: Record<string, number>) =>
      validateResponse({ requestId: 'req-100', actionId: 0, combatDamageSplit }, request);
    expect(send({ P3: 6 })).toBeNull();
    expect(send({ P3: 7 })).toMatch(/must sum to exactly 6/);
  });
});

describe('Response Validator', () => {
  it('accepts valid response matching legal menu', () => {
    const req = fixtureRequest();
    const err = validateResponse({ requestId: 'req-100', actionId: 0 }, req);
    expect(err).toBeNull();
  });

  it('accepts valid response with target choice', () => {
    const req = fixtureRequest();
    const err = validateResponse(
      { requestId: 'req-100', actionId: 1, targets: [{ slot: 0, choice: 'perm-1' }] },
      req,
    );
    expect(err).toBeNull();
  });

  it('rejects requestId mismatch', () => {
    const req = fixtureRequest();
    const err = validateResponse({ requestId: 'wrong-id', actionId: 0 }, req);
    expect(err).toContain('requestId mismatch');
  });

  it('rejects invalid actionId', () => {
    const req = fixtureRequest();
    const err = validateResponse({ requestId: 'req-100', actionId: 99 }, req);
    expect(err).toContain('actionId 99 is not on the legal menu');
  });

  it('rejects target choice not in legal slot options', () => {
    const req = fixtureRequest();
    const err = validateResponse(
      { requestId: 'req-100', actionId: 1, targets: [{ slot: 0, choice: 'illegal-target' }] },
      req,
    );
    expect(err).toContain('is not in legal options');
  });

  it('rejects malformed planned actions before they reach the local executor', () => {
    const req = fixtureRequest();
    expect(
      validateResponse(
        {
          requestId: req.requestId,
          actionId: 0,
          plannedActions: [{ type: 42 as unknown as string }],
        },
        req,
      ),
    ).toMatch(/plannedActions/);
  });
});
