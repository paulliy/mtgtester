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
import { RandomDecisionProvider } from '@mtg/engine';
import { MatchSession } from './session';
import type { SeatSetup } from './setup';
import { testerPolicy } from './disclosure';

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
    disclosure: testerPolicy('spectator'),
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

describe('MatchSession — the player at the table (ADR 0035 phase 3)', () => {
  type Required = Extract<ServerToClientMessage, { type: 'playerActionRequired' }>;
  type DiplomacyMessage = Extract<ServerToClientMessage, { type: 'diplomacyState' }>;

  it('lets the player propose and answer deals while the bots play on', async () => {
    const sent: ServerToClientMessage[] = [];
    const session = new MatchSession({
      disclosure: testerPolicy('singlePlayer'),
      gameId: 'g-diplomacy-player',
      seed: SEED,
      seats: seats(),
      providerKind: 'random',
      gameMode: 'singlePlayer',
      humanSeat: 'P1',
      turnCap: 14,
      livePaceMs: 0,
      diplomacy: true,
      send: (message) => sent.push(message),
    });
    expect(session.hasDiplomacy()).toBe(true);
    const chooser = new RandomDecisionProvider('diplomacy-player');
    const answered = new Set<string>();
    let consumed = 0;
    let proposedOnTurn = -1;
    let invalidChecked = false;
    session.start();

    const deadline = Date.now() + 60_000;
    while (
      !sent.some((m) => m.type === 'gameOver' || m.type === 'computeHalted') &&
      Date.now() < deadline
    ) {
      const latest = sent.filter((m): m is DiplomacyMessage => m.type === 'diplomacyState').at(-1);
      if (latest !== undefined) {
        const { state } = latest.payload;
        // Accept every offer the bots make, once.
        for (const offer of state.offers) {
          if (answered.has(offer.id)) continue;
          answered.add(offer.id);
          session.answerDeal('P1', { dealId: offer.id, answer: 'accept' });
        }
        if (!invalidChecked && state.turn >= 1) {
          invalidChecked = true;
          session.proposeDeal('P1', { to: 'P2', rounds: 9, obligations: [] });
          const reply = sent.at(-1);
          expect(reply).toMatchObject({
            type: 'diplomacyState',
            payload: { outcome: { kind: 'refused', reason: 'invalid' } },
          });
        }
        const partner = state.partners[0];
        if (state.canPropose && partner !== undefined && proposedOnTurn !== state.turn) {
          proposedOnTurn = state.turn;
          session.proposeDeal('P1', {
            to: partner,
            rounds: 1,
            obligations: [
              { kind: 'noAttack', by: 'P1', against: partner },
              { kind: 'noAttack', by: partner, against: 'P1' },
            ],
          });
        }
      }
      const next = sent.filter((m): m is Required => m.type === 'playerActionRequired')[consumed];
      if (next === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        continue;
      }
      consumed += 1;
      const response = chooser.decide(next.payload.request);
      session.submitPlayerAction('P1', {
        requestId: response.requestId,
        actionId: response.actionId,
        revision: next.payload.revision,
        ...(response.targets !== undefined ? { targets: response.targets } : {}),
      });
    }
    session.abandon();
    await session.settled();

    const talk = sent.flatMap((m) => (m.type === 'eventBatch' ? (m.payload.tableTalk ?? []) : []));
    // The player's own proposals are in the talk, under its own seat.
    expect(talk.some((l) => l.message.kind === 'proposal' && l.message.from === 'P1')).toBe(true);
    // The table never speaks for the player: everything P1 "said" is its own proposal or answer.
    for (const line of talk) {
      const m = line.message;
      if ('from' in m && m.from === 'P1') expect(['proposal', 'response']).toContain(m.kind);
    }
    const outcomes = sent.flatMap((m) =>
      m.type === 'diplomacyState' && m.payload.outcome !== undefined ? [m.payload.outcome] : [],
    );
    expect(outcomes.some((o) => o.kind === 'accepted')).toBe(true);
    const states = sent.flatMap((m) => (m.type === 'diplomacyState' ? [m.payload.state] : []));
    expect(states.some((st) => st.deals.some((d) => d.parties.includes('P1')))).toBe(true);
    expect(session.tableTalk()).toEqual(talk);
    // Every decision the player is asked for comes after the table state for its own turn, so
    // the panel never shows the previous turn's offers or proposal slot while the player decides.
    let lastTurn = -1;
    for (const m of sent) {
      if (m.type === 'diplomacyState') lastTurn = m.payload.state.turn;
      if (m.type === 'playerActionRequired' && m.payload.request.turn >= 1) {
        expect(lastTurn).toBe(m.payload.request.turn);
      }
    }
  }, 120_000);

  it('refuses deal messages in a game without deals', () => {
    const sent: ServerToClientMessage[] = [];
    const session = new MatchSession({
      disclosure: testerPolicy('singlePlayer'),
      gameId: 'g-no-deals',
      seed: SEED,
      seats: seats(),
      providerKind: 'random',
      gameMode: 'singlePlayer',
      humanSeat: 'P1',
      send: (message) => sent.push(message),
    });
    session.proposeDeal('P1', { to: 'P2', rounds: 1, obligations: [] });
    expect(sent.at(-1)).toEqual({
      type: 'error',
      payload: { message: 'Deals are off in this game.' },
    });
    expect(sent.some((m) => m.type === 'diplomacyState')).toBe(false);
  });
});
