import { describe, expect, it } from 'vitest';
import type { PlayerBoardState } from '@mtg/shared';
import { clickableObjectIds } from './clickableObjects';

const card = (id: string) => ({ id });

/** Only the fields `clickableObjectIds` reads. */
function board(): PlayerBoardState {
  return {
    viewerSeat: 'P1',
    battlefield: [card('perm-1')],
    exile: [card('exiled-1')],
    revealedLibraryTops: [{ player: 'P2', card: card('top-2') }],
    knownHands: [{ player: 'P2', cards: [card('seen-in-p2-hand')] }],
    seats: [
      {
        seat: 'P1',
        hand: [card('hand-1')],
        graveyard: [card('grave-1')],
        commanders: [
          { zone: 'command', objectId: 'cmdr-1' },
          { zone: 'battlefield', objectId: 'perm-1' },
        ],
      },
      {
        seat: 'P2',
        hand: null,
        graveyard: [card('grave-2')],
        commanders: [{ zone: 'library', objectId: 'cmdr-2-hidden' }],
      },
    ],
  } as unknown as PlayerBoardState;
}

describe('clickableObjectIds', () => {
  it('holds every object the board draws as clickable', () => {
    const ids = clickableObjectIds(board());
    for (const id of ['perm-1', 'exiled-1', 'top-2', 'hand-1', 'grave-1', 'grave-2', 'cmdr-1']) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it('leaves out cards with nothing on screen to click, so their choices go to the panel', () => {
    const ids = clickableObjectIds(board());
    // A card seen in another player's hand, a commander off in a hidden zone, a library card,
    // and seat ids (a choice about a player always goes to the panel).
    for (const id of ['seen-in-p2-hand', 'cmdr-2-hidden', 'library-card', 'P1', 'P2']) {
      expect(ids.has(id), id).toBe(false);
    }
  });

  it('is empty with no board', () => {
    expect(clickableObjectIds(null).size).toBe(0);
  });
});
