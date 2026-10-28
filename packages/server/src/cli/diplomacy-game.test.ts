import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { Engine, runToCompletion } from '@mtg/engine';
import { HeuristicDecisionProvider } from '@mtg/bot';
import { describe, expect, it } from 'vitest';
import { buildSupportedPool } from '../cards/pool';
import { generateCommanderDeck } from '../decks/generate';
import { MAX_CONCESSION_PER_DEAL, summarizeExploits } from '@mtg/bot';
import { playDiplomacyGame } from './diplomacy-game';

const pool = buildSupportedPool(
  JSON.parse(
    readFileSync(resolve('packages/server/fixtures/coverage-oracle.json'), 'utf8'),
  ) as OracleCard[],
);
// The sweep's first game: its table talk starts on turn 11.
const seed = 'diplomacy-g0';
const decks = Array.from({ length: 4 }, (_, i) =>
  generateCommanderDeck(pool, { seed: `${seed}-seat${i + 1}` }),
);
const TURN_CAP = 14;

describe('playDiplomacyGame (ADR 0035)', () => {
  it('plays a real seeded game with every seat negotiating, identically each time', () => {
    const run = () =>
      playDiplomacyGame({
        seed,
        turnCap: TURN_CAP,
        diplomacySeats: ['P1', 'P2', 'P3', 'P4'],
        decks,
      });
    const first = run();
    const second = run();
    expect(second).toEqual(first);
    expect(first.turns).toBeGreaterThan(0);
    expect(first.messages.length).toBeGreaterThan(0);
  }, 120_000);

  it('leaves plain seats exactly as they play without the table', () => {
    const viaTable = playDiplomacyGame({ seed, turnCap: TURN_CAP, diplomacySeats: [], decks });
    expect(viaTable.messages).toEqual([]);

    const engine = new Engine({
      gameId: 'diplomacy-sweep',
      seed,
      players: decks.map((deck, i) => ({
        id: `P${i + 1}`,
        deckId: `diplomacy-${i + 1}`,
        commanders: [deck.commander],
        cards: deck.cards,
      })),
      turnCap: TURN_CAP,
    });
    const providers = new Map<string, HeuristicDecisionProvider>();
    const plain = runToCompletion(engine, (seat) => {
      let p = providers.get(seat);
      if (p === undefined) {
        p = new HeuristicDecisionProvider(`${seed}-${seat}`, () => engine.view(seat));
        providers.set(seat, p);
      }
      return p;
    });
    expect(viaTable.turns).toBe(plain.turnCount);
    expect(viaTable.winner).toBe(plain.winnerSeat);
    expect(viaTable.finalLife).toEqual(
      Object.fromEntries(engine.getState().players.map((p) => [p.id, p.life])),
    );
  }, 120_000);
});

describe('playDiplomacyGame — an exploiter at the table (ADR 0035 phase 3)', () => {
  it('cannot pad, cannot deal past its breaches, and gets at most the bounded concession per deal', () => {
    const result = playDiplomacyGame({
      seed,
      turnCap: 20,
      diplomacySeats: ['P2', 'P3', 'P4'],
      exploiterSeat: 'P1',
      decks,
    });
    const exploits = result.exploits ?? [];
    expect(exploits.length).toBeGreaterThan(0);
    // Padding is refused before it is ever put to a bot.
    expect(
      exploits.filter((r) => r.tactic === 'padding').every((r) => r.outcome === 'refused'),
    ).toBe(true);
    const summary = summarizeExploits(exploits);
    expect(summary.paddingAccepted).toBe(0);
    expect(summary.acceptedPastTolerance).toBe(0);
    expect(summary.worstConcession).toBeLessThanOrEqual(MAX_CONCESSION_PER_DEAL);
    // The table never speaks for the exploiter: everything it said was an offer.
    for (const m of result.messages) {
      if ('from' in m && m.from === 'P1') expect(['proposal', 'breach']).toContain(m.kind);
    }
  }, 180_000);
});
