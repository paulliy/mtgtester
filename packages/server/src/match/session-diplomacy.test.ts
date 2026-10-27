/**
 * Table talk in a spectator game (ADR 0035 phase 2): the session runs the table, anchors what it
 * says to the log, releases it with the lines, and leaves games without diplomacy untouched.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OracleCard, ServerToClientMessage, TableTalkLine } from '@mtg/shared';
import { buildSupportedPool } from '../cards/pool';
import { generateCommanderDeck } from '../decks/generate';
import { MatchSession } from './session';
import type { SeatSetup } from './setup';

const pool = buildSupportedPool(
  JSON.parse(
    readFileSync(resolve('packages/server/fixtures/coverage-oracle.json'), 'utf8'),
  ) as OracleCard[],
);
// The diplomacy sweep's first game: its table talk starts on turn 11.
const SEED = 'diplomacy-g0';

function seats(): SeatSetup[] {
  return [1, 2, 3, 4].map((n) => {
    const deck = generateCommanderDeck(pool, { seed: `${SEED}-seat${n}` });
    return {
      seat: `P${n}`,
      deckSnapshotId: null,
      config: {
        id: `P${n}`,
        deckId: `diplomacy-${n}`,
        commanders: [deck.commander],
        cards: deck.cards,
      },
      summary: {
        seat: `P${n}`,
        deckId: `diplomacy-${n}`,
        label: deck.commander.name,
        commanderNames: [deck.commander.name],
        colorIdentity: deck.commander.colorIdentity,
        archetypeTag: 'test',
      },
    };
  });
}

async function play(options: { diplomacy?: boolean; gameMode?: 'singlePlayer' } = {}) {
  const sent: ServerToClientMessage[] = [];
  const session = new MatchSession({
    gameId: 'g-diplomacy',
    seed: SEED,
    seats: seats(),
    providerKind: 'random',
    turnCap: 14,
    playbackMode: 'live',
    livePaceMs: 0,
    ...(options.diplomacy !== undefined && { diplomacy: options.diplomacy }),
    send: (message) => sent.push(message),
  });
  session.start();
  await session.settled();
  const batches = sent.flatMap((m) => (m.type === 'eventBatch' ? [m.payload] : []));
  return { session, batches };
}

describe('MatchSession — table talk (ADR 0035)', () => {
  it('delivers the table talk with the log lines it belongs to', async () => {
    const { session, batches } = await play({ diplomacy: true });
    expect(session.hasDiplomacy()).toBe(true);
    const talk: TableTalkLine[] = batches.flatMap((b) => b.tableTalk ?? []);
    expect(talk.length).toBeGreaterThan(0);
    // History is exactly what viewers were streamed, snapped anchors included, so a reload
    // finds each line beside the same log line.
    expect(session.tableTalk()).toEqual(talk);
    const sequences = new Set(batches.flatMap((b) => b.lines.map((l) => l.sequence)));
    for (const batch of batches) {
      for (const line of batch.tableTalk ?? []) {
        expect(line.text.length).toBeGreaterThan(0);
        // Snapped onto a line in its own batch, unless it is the game-end batch with no lines.
        if (batch.lines.length > 0) expect(sequences.has(line.sequence)).toBe(true);
      }
    }
  }, 120_000);

  it('sends no table talk and grows no payload when diplomacy is off', async () => {
    const { session, batches } = await play();
    expect(session.hasDiplomacy()).toBe(false);
    expect(batches.every((b) => !('tableTalk' in b))).toBe(true);
  }, 120_000);
});
