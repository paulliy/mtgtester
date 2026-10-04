import { describe, expect, it } from 'vitest';
import { Engine, buildPlayerBoardState } from '../src';
import { createGame } from '../src/state/game';
import { manaSourcesFor } from '../src/state/queries';
import {
  commanderFor,
  copies,
  forest,
  gameConfig,
  island,
  oracle,
  plains,
  spawn,
} from './fixtures';

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

  it("summarises the viewer's ready mana without counting tapped or mana-costing sources", () => {
    const ctx = createGame(pod());
    const land = (name: string, oracleText: string) =>
      oracle({
        name,
        typeLine: 'Land',
        manaCost: null,
        cmc: 0,
        power: null,
        toughness: null,
        oracleText,
      });
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', island());
    spawn(ctx, 'P1', plains(), { tapped: true });
    spawn(ctx, 'P1', land('Azorius Test Gate', '{T}: Add {W} or {U}.'));
    const costly = spawn(ctx, 'P1', land('Test Vault', '{1}, {T}: Add {B}{B}.'));
    const restricted = spawn(
      ctx,
      'P1',
      land(
        'Test Haven',
        '{T}: Add one mana of any color. Spend this mana only to cast a Dragon creature spell.',
      ),
    );
    spawn(ctx, 'P2', forest());
    const player = ctx.state.players.find((candidate) => candidate.id === 'P1');
    if (player === undefined) throw new Error('missing P1');
    player.manaPool.R = 1;

    // The costly and restricted sources are real, activatable mana sources — excluded on purpose.
    const sources = manaSourcesFor(ctx, 'P1');
    expect(sources.find((source) => source.cardId === costly.cardId)?.manaCost).toBeDefined();
    expect(
      sources.find((source) => source.cardId === restricted.cardId)?.restriction,
    ).toBeDefined();
    // Forest, Island, the gate's one unit, and the floating red; not the tapped Plains, the
    // costly or restricted sources, or P2's Forest.
    expect(buildPlayerBoardState(ctx, 'P1').viewerMana).toEqual({
      units: 4,
      colors: ['W', 'U', 'R', 'G'],
    });
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
