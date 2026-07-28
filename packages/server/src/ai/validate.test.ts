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
