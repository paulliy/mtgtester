/**
 * The anti-cheat boundary (brief §7.1, §12): a `PlayerView` never contains another
 * player's hand, any library order (including the viewer's own), or another player's
 * decklist.
 */

import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine';
import { buildPlayerView } from '../src/view/view';
import { createGame } from '../src/state/game';
import { commanderFor, conjure, copies, forest, gameConfig, oracle } from './fixtures';

function secretPod(): ReturnType<typeof gameConfig> {
  const secret = (name: string): ReturnType<typeof oracle> =>
    oracle({
      name,
      typeLine: 'Creature — Test Secret',
      manaCost: '{1}',
      power: '1',
      toughness: '1',
    });
  return gameConfig(
    [
      {
        commander: commanderFor('G', 'Viewer General'),
        cards: [...copies(10, forest), secret('Own Tech Alpha')],
      },
      {
        commander: commanderFor('R', 'Enemy General Two'),
        cards: [...copies(10, forest), secret('Secret Sauce Two')],
      },
      {
        commander: commanderFor('U', 'Enemy General Three'),
        cards: [...copies(10, forest), secret('Secret Sauce Three')],
      },
      {
        commander: commanderFor('B', 'Enemy General Four'),
        cards: [...copies(10, forest), secret('Secret Sauce Four')],
      },
    ],
    { seed: 'visibility' },
  );
}

describe('PlayerView visibility (brief §7.1)', () => {
  it('contains no opponent hands, no opponent decklists, and no library order', () => {
    const engine = new Engine(secretPod());
    // Advance into the game so hands exist.
    const step = engine.advance();
    expect(step.kind).toBe('decision');

    const view = engine.view('P1');
    const json = JSON.stringify(view);

    // Opponent deck/hand/library contents never appear — not anywhere in the payload.
    expect(json).not.toContain('Secret Sauce Two');
    expect(json).not.toContain('Secret Sauce Three');
    expect(json).not.toContain('Secret Sauce Four');

    // Opponents are reported as counts, not contents.
    for (const opp of view.opponents) {
      expect(typeof opp.handSize).toBe('number');
      expect(typeof opp.librarySize).toBe('number');
      expect(json).not.toContain('"hand":undefined');
    }
    expect(view.opponents).toHaveLength(3);

    // The viewer's OWN decklist is visible (contents), including cards still in-library.
    expect(json).toContain('Own Tech Alpha');
    // But no structure carries the viewer's library ORDER: the deck list is in fixed
    // decklist order (commanders first, then the configured card order), independent of
    // the shuffled library.
    expect(view.deck[0]?.name).toBe('Viewer General');
    const deckNames = view.deck.map((c) => c.name);
    expect(deckNames.slice(1, 11)).toEqual(Array.from({ length: 10 }, () => 'Forest'));
    expect((view as unknown as Record<string, unknown>)['library']).toBeUndefined();

    // Commanders everywhere are public.
    expect(json).toContain('Enemy General Two');
  });

  it('never leaks drawn/bottomed card identities through the recent log', () => {
    const ctx = createGame(secretPod());
    ctx.state.currentTurnPlayer = 'P1';
    const p2 = ctx.state.players.find((p) => p.id === 'P2');
    if (p2 === undefined) throw new Error('no P2');
    // Simulate P2 having drawn their secret card: event log carries it internally.
    conjure(
      ctx,
      'P2',
      oracle({
        name: 'Deep Secret',
        typeLine: 'Instant',
        power: null,
        toughness: null,
        oracleText: 'Draw a card.',
        manaCost: '{U}',
      }),
      'hand',
    );
    ctx.state.eventLog.push({
      sequence: ctx.state.nextEventSequence++,
      turn: 1,
      phase: 'beginning',
      step: 'draw',
      actorSeat: 'P2',
      type: 'draw',
      payload: { player: 'P2', cardId: 'x', name: 'Deep Secret' },
    });
    ctx.state.eventLog.push({
      sequence: ctx.state.nextEventSequence++,
      turn: 1,
      phase: 'beginning',
      step: 'draw',
      actorSeat: 'P2',
      type: 'zoneChange',
      payload: { cardId: 'x', name: 'Deep Secret', from: 'library', to: 'hand', owner: 'P2' },
    });

    const view = buildPlayerView(ctx, 'P1');
    expect(JSON.stringify(view)).not.toContain('Deep Secret');
  });
});
