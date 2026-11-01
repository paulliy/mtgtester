import { describe, expect, it } from 'vitest';
import type {
  DecisionRequest,
  GameEvent,
  GameResult,
  LegalAction,
  PlayerBoardState,
} from '@mtg/shared';
import {
  enrichPresentation,
  gameOverSummary,
  playerFacingEvents,
  playerFacingPrompt,
} from './presentation';

/** The enrichment reads only the seat's battlefield ids from its projection. */
function boardWith(...ids: string[]): PlayerBoardState {
  return { battlefield: ids.map((id) => ({ id })) } as unknown as PlayerBoardState;
}

function request(
  legalActions: LegalAction[],
  over: Partial<DecisionRequest> = {},
): DecisionRequest {
  return {
    requestId: 'r1',
    gameId: 'g1',
    turn: 3,
    activePlayer: 'P1',
    decidingPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    decisionType: 'priority',
    prompt: 'You have priority (precombatMain). Choose an action.',
    legalActions,
    ...over,
  };
}

const pass: LegalAction = {
  id: 0,
  type: 'pass',
  description: 'Pass priority',
  interaction: { kind: 'immediate' },
};
const bolt: LegalAction = {
  id: 1,
  type: 'castSpell',
  description: 'Cast Lightning Bolt ({R})',
  data: {
    sourceName: 'Lightning Bolt',
    manaCost: '{R}',
    paymentSourceIds: ['o-1', 'o-2', 'o-hidden'],
    paymentSourceNames: ['Mountain', 'Mountain', 'Island'],
  },
  interaction: { kind: 'source', sourceId: 'o-9' },
};

describe('playerFacingPrompt', () => {
  it('rewrites the engine priority prompt parenthetical', () => {
    expect(playerFacingPrompt('You have priority (precombatMain). Choose an action.')).toBe(
      'You have priority (Main phase 1). Choose an action.',
    );
    expect(playerFacingPrompt('You have priority (beginning, upkeep). Choose an action.')).toBe(
      'You have priority (Beginning · Upkeep). Choose an action.',
    );
  });

  it('leaves other parentheticals alone', () => {
    expect(playerFacingPrompt('Discard down to seven cards (8 in hand).')).toBe(
      'Discard down to seven cards (8 in hand).',
    );
    expect(playerFacingPrompt('Pay (beginning, notAStep) now')).toBe(
      'Pay (beginning, notAStep) now',
    );
  });
});

describe('enrichPresentation', () => {
  it('gives a priority menu a priority layout, a player prompt, and an entry per action', () => {
    const sent = enrichPresentation(request([pass, bolt]), boardWith('o-1', 'o-2'));
    expect(sent.presentation?.layout).toBe('priority');
    expect(sent.presentation?.playerPrompt).toBe(
      'You have priority (Main phase 1). Choose an action.',
    );
    expect(sent.presentation?.actions?.[0]).toEqual({ verb: 'Pass', subjects: [] });
    expect(sent.presentation?.actions?.[1]).toEqual({
      verb: 'Cast',
      subjects: [],
      label: 'Cast',
      summary: 'Cast Lightning Bolt',
      costLabels: ['{R}'],
      // Only the seat's own permanents: the id outside its projection is dropped.
      payment: { sourceIds: ['o-1', 'o-2'], summary: 'Mountain ×2, Island' },
    });
  });

  it('does not change the request it was given', () => {
    const original = request([pass, bolt]);
    const copy = structuredClone(original);
    enrichPresentation(original, boardWith());
    expect(original).toEqual(copy);
  });

  it('keeps the unknown action type in the engine words', () => {
    const odd: LegalAction = { id: 5, type: 'mysteryAction', description: 'Do the mystery' };
    expect(enrichPresentation(request([odd]), boardWith()).presentation?.actions?.[5]?.verb).toBe(
      'Do the mystery',
    );
  });

  it('gives a mana ability its label, summary and symbols', () => {
    const tap: LegalAction = {
      id: 2,
      type: 'activateManaAbility',
      description: 'Forest: add {G}',
      data: { sourceName: 'Forest', symbols: ['G'], abilityCosts: [{ kind: 'tap' }] },
      interaction: { kind: 'source', sourceId: 'o-3' },
    };
    expect(enrichPresentation(request([tap]), boardWith()).presentation?.actions?.[2]).toEqual({
      verb: 'Tap for mana',
      subjects: [],
      label: 'Tap for {G}',
      summary: 'Tap Forest for {G}',
      costLabels: ['Tap this'],
      manaSymbols: ['G'],
    });
  });

  it('describes a land face, an X family and a target-dependent cost', () => {
    const land: LegalAction = {
      id: 3,
      type: 'playLand',
      description: 'Play Ondu Skyruins',
      data: { castVariant: 'mdfc', sourceName: 'Ondu Skyruins', entersTapped: true },
    };
    const xSpell: LegalAction = {
      id: 4,
      type: 'castSpell',
      description: 'Cast Blaze (X=2)',
      data: { x: 2, modeLabel: 'deal damage', targetReductionSlot: 0 },
    };
    const sent = enrichPresentation(request([land, xSpell]), boardWith()).presentation;
    expect(sent?.actions?.[3]).toMatchObject({
      label: 'Play Ondu Skyruins',
      entryNote: 'enters tapped',
    });
    expect(sent?.actions?.[4]).toMatchObject({
      label: 'Deal damage',
      xFamily: { key: 'castSpell|deal damage', x: 2 },
      targetHint: 'reduced for target slot 1',
    });
  });

  it('has no entry for an action the menu no longer holds', () => {
    // The session removes a yielded ability before enriching; nothing is left to describe.
    const yielded: LegalAction = {
      id: 7,
      type: 'activateAbility',
      description: 'Activate Orb',
      data: { sourceName: 'Orb' },
    };
    const full = request([pass, bolt, yielded]);
    const filtered = request([pass, bolt]);
    expect(
      Object.keys(enrichPresentation(full, boardWith()).presentation?.actions ?? {}),
    ).toContain('7');
    expect(
      Object.keys(enrichPresentation(filtered, boardWith()).presentation?.actions ?? {}),
    ).toEqual(['0', '1']);
  });

  it('keeps the engine layout and entries of a choice decision, adding the prompt', () => {
    const discard: LegalAction = { id: 0, type: 'discard', description: 'Discard Forest' };
    const sent = enrichPresentation(
      request([discard], {
        decisionType: 'general',
        prompt: 'Discard down to seven cards (8 in hand).',
        presentation: {
          layout: 'cards',
          actions: { 0: { verb: 'Discard', subjects: [], role: 'select' } },
        },
      }),
      boardWith(),
    );
    expect(sent.presentation).toEqual({
      layout: 'cards',
      playerPrompt: 'Discard down to seven cards (8 in hand).',
      actions: { 0: { verb: 'Discard', subjects: [], role: 'select' } },
    });
  });

  it('adds the new fields to a cast inside a choice decision, and drops entries for absent actions', () => {
    const free: LegalAction = {
      id: 1,
      type: 'castSpell',
      description: 'Cast Opt',
      data: { sourceName: 'Opt', manaCost: 'free' },
    };
    const sent = enrichPresentation(
      request([free], {
        decisionType: 'general',
        presentation: {
          layout: 'choices',
          actions: {
            1: { verb: 'Cast for free', subjects: [] },
            9: { verb: 'Stale', subjects: [] },
          },
        },
      }),
      boardWith(),
    );
    expect(Object.keys(sent.presentation?.actions ?? {})).toEqual(['1']);
    expect(sent.presentation?.actions?.[1]).toEqual({
      verb: 'Cast for free',
      subjects: [],
      label: 'Cast',
      summary: 'Cast Opt',
      costLabels: ['free'],
    });
  });

  it('gives a decision with no engine presentation and no casts only the prompt', () => {
    const keep: LegalAction = { id: 0, type: 'keep', description: 'Keep this hand' };
    const sent = enrichPresentation(
      request([keep], { decisionType: 'mulligan', prompt: 'Keep this hand or mulligan?' }),
      boardWith(),
    );
    expect(sent.presentation).toEqual({
      layout: 'choices',
      playerPrompt: 'Keep this hand or mulligan?',
    });
  });
});

describe('gameOverSummary', () => {
  const result: GameResult = {
    gameId: 'g',
    winnerSeat: 'P2',
    finishingOrder: ['P1', 'P3', 'P4', 'P2'],
    turnCount: 12,
    halted: false,
    haltReason: null,
  };

  it('names the winner and the length, or a draw, or a stop', () => {
    expect(gameOverSummary(result)).toBe('Game over — winner P2 after 12 turns');
    expect(gameOverSummary({ ...result, winnerSeat: null })).toBe(
      'Game over — draw after 12 turns',
    );
    expect(gameOverSummary({ ...result, turnCount: 1 })).toBe('Game over — winner P2 after 1 turn');
  });

  it('never names a halt reason', () => {
    const halted = gameOverSummary({
      ...result,
      winnerSeat: null,
      halted: true,
      haltReason: 'engine invariant at resolve.ts:4200',
    });
    expect(halted).toBe('Game over — the game stopped after 12 turns');
    expect(halted).not.toContain('resolve');
  });
});

describe('playerFacingEvents', () => {
  const event = (type: string, payload: Record<string, unknown>): GameEvent =>
    ({ sequence: 1, turn: 2, type, actorSeat: 'P2', payload }) as GameEvent;

  it('writes the elimination reason in player terms, and only there', () => {
    const [out, other] = playerFacingEvents([
      event('playerEliminated', { reason: 'lifeZeroOrLess' }),
      event('draw', { reason: 'lifeZeroOrLess' }),
    ]);
    expect(out?.payload['reason']).toBe('Life total reached 0');
    expect(other?.payload['reason']).toBe('lifeZeroOrLess');
  });

  it('shows an unrecognised stored reason as recorded and leaves the input alone', () => {
    const input = event('playerEliminated', { reason: 'somethingNew' });
    expect(playerFacingEvents([input])[0]?.payload['reason']).toBe('somethingNew');
    expect(input.payload['reason']).toBe('somethingNew');
  });
});
