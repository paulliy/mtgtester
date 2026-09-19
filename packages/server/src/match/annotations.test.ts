/**
 * ADR 0022's release rules for AI reasoning annotations. The single-player case here is a
 * hidden-information boundary, not a display preference — the same class of test as the
 * `PlayerView` visibility check in brief §12.
 */

import { describe, expect, it } from 'vitest';
import type { AiAnnotation, SpectatorLogLine } from '@mtg/shared';
import { releaseAnnotations } from './annotations';

function line(sequence: number, turn = 1): SpectatorLogLine {
  return { sequence, turn, actorSeat: 'P1', text: `line ${sequence}` };
}

function note(sequence: number, text = 'because it was the best play'): AiAnnotation {
  return { sequence, turn: 1, seat: 'P1', kind: 'decision', text, source: 'primary' };
}

const SPECTATOR = { gameMode: 'spectator', showReasoning: true } as const;

describe('releaseAnnotations — the hidden-information gate', () => {
  it('withholds every annotation in a single-player game, holding rather than dropping them', () => {
    const pending = [note(1), note(5)];
    const result = releaseAnnotations({
      gameMode: 'singlePlayer',
      showReasoning: true,
      pending,
      lines: [line(1), line(5)],
    });

    expect(result.due).toEqual([]);
    // Held, not discarded: `publishGameOver` releases the whole set once the game is decided.
    expect(result.held).toEqual(pending);
  });

  it('sends nothing while the viewer has not opted in', () => {
    const result = releaseAnnotations({
      ...SPECTATOR,
      showReasoning: false,
      pending: [note(1)],
      lines: [line(1)],
    });

    expect(result.due).toEqual([]);
    expect(result.held).toHaveLength(1);
  });
});

describe('releaseAnnotations — placement', () => {
  it('attaches an annotation to its own line when that line is visible', () => {
    const result = releaseAnnotations({
      ...SPECTATOR,
      pending: [note(4)],
      lines: [line(2), line(4)],
    });

    expect(result.due).toEqual([expect.objectContaining({ sequence: 4 })]);
    expect(result.held).toEqual([]);
  });

  it('snaps forward to the next visible line when the anchored event produced no log line', () => {
    // A pass logs nothing, so the decision's own sequence is often absent from the batch.
    const result = releaseAnnotations({
      ...SPECTATOR,
      pending: [note(3)],
      lines: [line(2), line(7)],
    });

    expect(result.due).toEqual([expect.objectContaining({ sequence: 7 })]);
  });

  it('never snaps backward — reasoning must not appear before the play it explains', () => {
    const result = releaseAnnotations({
      ...SPECTATOR,
      pending: [note(9)],
      lines: [line(2), line(7)],
    });

    expect(result.due).toEqual([]);
    expect(result.held).toEqual([expect.objectContaining({ sequence: 9 })]);
  });

  it('releases a held annotation once its line finally arrives', () => {
    const first = releaseAnnotations({ ...SPECTATOR, pending: [note(9)], lines: [line(2)] });
    const second = releaseAnnotations({ ...SPECTATOR, pending: first.held, lines: [line(9)] });

    expect(second.due).toEqual([expect.objectContaining({ sequence: 9 })]);
    expect(second.held).toEqual([]);
  });

  it('places a batch out of order without losing any of it', () => {
    const result = releaseAnnotations({
      ...SPECTATOR,
      pending: [note(8, 'later'), note(2, 'earlier')],
      lines: [line(5), line(2)],
    });

    expect(result.due).toEqual([expect.objectContaining({ text: 'earlier', sequence: 2 })]);
    expect(result.held).toEqual([expect.objectContaining({ text: 'later' })]);
  });

  it('holds everything when a batch carries no lines at all', () => {
    const result = releaseAnnotations({ ...SPECTATOR, pending: [note(1)], lines: [] });

    expect(result.due).toEqual([]);
    expect(result.held).toHaveLength(1);
  });
});
