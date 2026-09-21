import { describe, expect, it } from 'vitest';
import { IllegalDecisionError } from '../src/errors';
import { RuleBasedProvider, drive, forestsPod, makeEngine, oracle } from './fixtures';

describe('Engine driver (brief §5.1)', () => {
  it('plays a do-nothing pod to a winner by deckout', () => {
    const engine = makeEngine(forestsPod(12), { seed: 'deckout-1' });
    const provider = new RuleBasedProvider([]);
    const result = drive(engine, provider);

    expect(result.halted).toBe(false);
    expect(result.winnerSeat).not.toBeNull();
    expect(result.finishingOrder).toHaveLength(4);
    expect(engine.getState().eliminatedPlayers).toHaveLength(3);

    // Everyone lost to drawing from an empty library.
    for (const p of engine.getState().players) {
      if (p.id === result.winnerSeat) continue;
      expect(p.lossReason).toBe('emptyLibraryDraw');
    }
  });

  it('never surfaces a forced decision (single option ⇒ no AI call, brief §5.1)', () => {
    const engine = makeEngine(forestsPod(8), { seed: 'auto-1' });
    const provider = new RuleBasedProvider([]);
    drive(engine, provider);
    for (const request of provider.seen) {
      expect(request.legalActions.length).toBeGreaterThan(1);
    }
  });

  it('only ever surfaces priority decisions to players with real options', () => {
    // In a forests-only pod, nobody can respond to anything: every surfaced priority
    // decision belongs to the active player (land play windows).
    const engine = makeEngine(forestsPod(8), { seed: 'auto-2' });
    const provider = new RuleBasedProvider([]);
    drive(engine, provider);
    for (const request of provider.seen) {
      if (request.decisionType === 'priority') {
        expect(request.decidingPlayer).toBe(request.activePlayer);
      }
    }
  });

  it('rejects illegal decisions without consuming them (brief §7.7)', () => {
    const engine = makeEngine(forestsPod(8), { seed: 'reject-1' });
    const step = engine.advance();
    if (step.kind !== 'decision') throw new Error('expected a decision');
    const request = step.request;

    expect(() => engine.submit({ requestId: 'bogus', actionId: 0 })).toThrow(IllegalDecisionError);
    expect(() => engine.submit({ requestId: request.requestId, actionId: 999 })).toThrow(
      IllegalDecisionError,
    );

    // The same decision is still pending and answerable.
    const again = engine.advance();
    if (again.kind !== 'decision') throw new Error('expected the same decision');
    expect(again.request.requestId).toBe(request.requestId);
    engine.submit({ requestId: request.requestId, actionId: 0 });
    expect(engine.advance().kind).not.toBe('gameOver');
  });

  it('halts loudly when an unmodeled card needs behavior (brief §6.3)', () => {
    const pod = forestsPod(8);
    const seatCards = pod[0] as { cards: ReturnType<typeof forestsPod>[0]['cards'] };
    seatCards.cards = [
      ...seatCards.cards.slice(0, 6),
      // An unmodelable card that will end up in hand or be drawn. Deliberately a line no grammar
      // claims — a bare keyword is a poor choice here, because implementing that keyword later
      // (Cascade was exactly this) silently turns the fixture modelable and the test green for
      // the wrong reason.
      ...Array.from(
        {
          length: 6,
        },
        () =>
          oracle({
            name: 'Mystery Box',
            oracleText: 'Whenever the moon is gibbous, ponder the void.',
          }),
      ),
    ];
    const engine = makeEngine(pod, { seed: 'halt-1' });
    const result = drive(engine, new RuleBasedProvider([]));
    expect(result.halted).toBe(true);
    expect(result.haltReason).toContain('Mystery Box');
  });
});
