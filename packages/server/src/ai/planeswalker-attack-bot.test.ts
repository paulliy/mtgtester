import { describe, expect, it } from 'vitest';
import { HeuristicDecisionProvider } from '@mtg/bot';
import { Engine } from '../../../engine/src/engine';
import { copies, forest, gameConfig, oracle } from '../../../engine/tests/fixtures';

const WALKER = oracle({
  name: 'Lab Walker',
  typeLine: 'Planeswalker — Lab',
  manaCost: '{2}',
  cmc: 2,
  loyalty: '4',
});
const BEAR = oracle({ name: 'Lab Bear', typeLine: 'Creature — Bear', manaCost: '{G}', cmc: 1 });

describe('heuristic bots in games with planeswalkers', () => {
  it('finishes a game where they are offered planeswalker attack targets, without crashing or an illegal answer', () => {
    const seats = [0, 1, 2, 3].map(() => ({
      cards: [...copies(12, forest), ...copies(10, () => BEAR), ...copies(6, () => WALKER)],
    }));
    const engine = new Engine(gameConfig(seats, { seed: 'pw-bot', turnCap: 14 }));
    const bots = new Map(
      ['P1', 'P2', 'P3', 'P4'].map((seat) => [
        seat,
        new HeuristicDecisionProvider(`pw-${seat}`, () => engine.view(seat)),
      ]),
    );
    // The bots must have been offered planeswalker attack targets, and the game must reach its
    // end (the turn cap) rather than run out of iterations. Whether a bot chooses a planeswalker
    // is a strategy matter; every answer it gives is checked by the engine on submission.
    let planeswalkerOffers = 0;
    let finished = false;
    for (let i = 0; i < 30_000; i += 1) {
      const step = engine.advance();
      if (step.kind === 'gameOver') {
        finished = true;
        break;
      }
      if (step.kind !== 'decision') continue;
      const subjects = step.request.presentation?.attackDeclaration?.subjects ?? [];
      if (subjects.some((subject) => subject.planeswalkers.length > 0)) planeswalkerOffers += 1;
      engine.submit(bots.get(step.request.decidingPlayer)!.decide(step.request));
    }
    expect(finished).toBe(true);
    expect(engine.getState().turnNumber).toBeGreaterThan(5);
    expect(planeswalkerOffers).toBeGreaterThan(0);
  }, 120_000);
});
