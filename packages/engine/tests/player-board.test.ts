import { describe, expect, it } from 'vitest';
import { Engine, buildPlayerBoardState } from '../src';
import { createGame } from '../src/state/game';
import { commanderFor, copies, forest, gameConfig, oracle, spawn } from './fixtures';

function pod() {
  const secret = (name: string) =>
    oracle({
      name,
      typeLine: 'Instant',
      manaCost: '{G}',
      oracleText: 'Gain 1 life.',
      power: null,
      toughness: null,
    });
  return gameConfig(
    [1, 2, 3, 4].map((seat) => ({
      commander: commanderFor('G', `General ${seat}`),
      cards: [...copies(10, forest), secret(`Secret ${seat}`)],
    })),
    { seed: 'player-board' },
  );
}

describe('Phase 6 player board projection', () => {
  it('shows only the viewing seat hand while preserving opponent hand counts', () => {
    const engine = new Engine(pod());
    expect(engine.advance().kind).toBe('decision');

    const view = engine.playerState('P1');
    const json = JSON.stringify(view);
    expect(view.seats.find((seat) => seat.seat === 'P1')?.hand).not.toBeNull();
    for (const seat of view.seats.filter((candidate) => candidate.seat !== 'P1')) {
      expect(seat.hand).toBeNull();
      expect(seat.handSize).toBeGreaterThan(0);
    }
    expect(json).not.toContain('Secret 2');
    expect(json).not.toContain('Secret 3');
    expect(json).not.toContain('Secret 4');
  });

  it('redacts an opponent face-down permanent before serialization', () => {
    const ctx = createGame(pod());
    const hidden = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Hidden Identity',
        typeLine: 'Creature — Shapeshifter',
        manaCost: '{2}{G}',
        oracleText: 'When this turns face up, draw a card.',
        power: '2',
        toughness: '2',
      }),
    );
    hidden.statuses.push('faceDown');

    const view = buildPlayerBoardState(ctx, 'P1');
    expect(JSON.stringify(view)).not.toContain('Hidden Identity');
    expect(view.battlefield.find((permanent) => permanent.id === hidden.id)?.name).toBe(
      'Face-down permanent',
    );
  });

  it('redacts opponent hideaway cards in exile', () => {
    const ctx = createGame(pod());
    const library = ctx.state.players.find((player) => player.id === 'P2')!.library;
    const hiddenIndex = library.findIndex((card) => card.name === 'Secret 2');
    const hidden = library.splice(hiddenIndex, 1)[0]!;
    hidden.attachedToCardId = 'opponent-hideaway-land';
    ctx.state.exile.push(hidden);

    const opponentView = buildPlayerBoardState(ctx, 'P1');
    const ownerView = buildPlayerBoardState(ctx, 'P2');
    expect(JSON.stringify(opponentView)).not.toContain(hidden.name);
    expect(opponentView.exile.find((card) => card.id === hidden.id)?.name).toBe('Face-down card');
    expect(ownerView.exile.find((card) => card.id === hidden.id)?.name).toBe(hidden.name);
  });

  it('attaches structured interaction metadata to every surfaced engine option', () => {
    const engine = new Engine(pod());
    const step = engine.advance();
    expect(step.kind).toBe('decision');
    if (step.kind !== 'decision') return;
    expect(step.request.legalActions.length).toBeGreaterThan(1);
    expect(step.request.legalActions.every((action) => action.interaction !== undefined)).toBe(
      true,
    );
  });

  it('includes a command-zone commander object for direct player selection', () => {
    const engine = new Engine(pod());
    engine.advance();

    const commander = engine.playerState('P1').seats.find((seat) => seat.seat === 'P1')
      ?.commanders[0];
    expect(commander?.zone).toBe('command');
    expect(commander?.objectId).toBeTruthy();
    expect(commander?.scryfallId).not.toBeUndefined();
  });
});
