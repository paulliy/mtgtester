// ADR 0032 decision 2: card types come from characteristics, and the server decides each
// permanent's board row, so a client never classifies from the printed type line.
import { describe, expect, it } from 'vitest';
import { buildPlayerBoardState } from '../src';
import type { StaticEffect } from '../src/cards/definition';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import { buildSpectatorState } from '../src/view/spectator';
import {
  commanderFor,
  copies,
  forest,
  gameConfig,
  oracle,
  registerCustomDef,
  spawn,
} from './fixtures';

const ctx = () =>
  createGame(
    gameConfig(
      [1, 2, 3, 4].map((seat) => ({
        commander: commanderFor('G', `General ${seat}`),
        cards: copies(10, forest),
      })),
      { seed: 'board-groups' },
    ),
  );

describe('board groups from computed types (ADR 0032 decision 2)', () => {
  it('groups an animated land with creatures, whatever its printed type line says', () => {
    const game = ctx();
    const card = oracle({
      name: 'Test Manland',
      typeLine: 'Land',
      manaCost: null,
      power: null,
      toughness: null,
    });
    const animated: StaticEffect = {
      affects: { kind: 'self' },
      op: { layer: 4, addTypes: ['Creature'] },
    };
    registerCustomDef(game, { ...interpretCard(card), staticEffects: [animated] });
    const manland = spawn(game, 'P1', card);

    for (const board of [buildSpectatorState(game), buildPlayerBoardState(game, 'P2')]) {
      const permanent = board.battlefield.find((p) => p.id === manland.id);
      expect(permanent?.typeLine).toBe('Land');
      expect(permanent?.types).toEqual(['Land', 'Creature']);
      expect(permanent?.boardGroup).toBe('creatures');
    }
  });

  it('groups a land creature such as Dryad Arbor with creatures in both views', () => {
    const game = ctx();
    const arbor = spawn(
      game,
      'P1',
      oracle({
        name: 'Dryad Arbor',
        typeLine: 'Land Creature — Forest Dryad',
        power: '1',
        toughness: '1',
      }),
    );
    const plain = spawn(game, 'P1', forest());

    for (const board of [buildSpectatorState(game), buildPlayerBoardState(game, 'P1')]) {
      expect(board.battlefield.find((p) => p.id === arbor.id)?.boardGroup).toBe('creatures');
      expect(board.battlefield.find((p) => p.id === plain.id)?.boardGroup).toBe('lands');
    }
  });

  it('gives a face-down permanent the plain Creature types of CR 708.2 for other players', () => {
    const game = ctx();
    const hidden = spawn(game, 'P2', forest());
    hidden.faceDown = true;

    const seen = buildPlayerBoardState(game, 'P1').battlefield.find((p) => p.id === hidden.id);
    expect(seen).toMatchObject({
      types: ['Creature'],
      supertypes: [],
      subtypes: [],
      boardGroup: 'creatures',
    });
  });

  it('gives cards off the battlefield their printed types and token flag', () => {
    const game = ctx();
    const p1 = game.state.players.find((player) => player.id === 'P1')!;
    const card = p1.library.pop()!;
    card.zone = 'graveyard';
    p1.graveyard.push(card);

    const seat = buildSpectatorState(game).seats.find((candidate) => candidate.seat === 'P1');
    expect(seat?.graveyard.find((c) => c.id === card.id)).toMatchObject({
      types: ['Land'],
      supertypes: ['Basic'],
      subtypes: ['Forest'],
      isToken: false,
    });
  });
});
