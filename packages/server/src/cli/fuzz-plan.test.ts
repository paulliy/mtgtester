import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import type { FuzzReply } from './fuzz-game';
import {
  failureOf,
  liveness,
  loadDecks,
  pod,
  PROVIDER_MIXES,
  withCard,
  type Outcome,
} from './fuzz-plan';

const decks = await loadDecks();

const played = (reply: Partial<FuzzReply>): Outcome => ({
  kind: 'played',
  reply: {
    winner: 'P1',
    turns: 30,
    decisions: 100,
    halt: null,
    error: null,
    budgetExhausted: false,
    emptyVetoes: 0,
    ops: [],
    exits: [],
    ms: 1000,
    ...reply,
  },
});
const HEURISTIC = PROVIDER_MIXES[0]!;
const RANDOM = PROVIDER_MIXES[1]!;
const turnCap = { reason: 'turn cap of 80 exceeded', turnCap: true };

describe('fuzz pods', () => {
  it('resolves every committed coverage deck against the pinned Oracle', () => {
    expect(decks.length).toBeGreaterThanOrEqual(10);
    for (const deck of decks) {
      expect(deck.commanders.length).toBeGreaterThan(0);
      expect(deck.cards.length + deck.commanders.length).toBeGreaterThanOrEqual(99);
    }
  });

  it('maps a seed to the same four distinct decks and a provider mix by seed', () => {
    for (let n = 0; n < 30; n++) {
      const picked = pod(decks, n);
      expect(picked).toEqual(pod(decks, n));
      expect(new Set(picked.decks.map((deck) => deck.label)).size).toBe(4);
      expect(picked.providers).toEqual(PROVIDER_MIXES[n % PROVIDER_MIXES.length]);
    }
    expect(pod(decks, 0).decks).not.toEqual(pod(decks, 1).decks);
  });

  it('puts a changed card in place of four basic lands and changes nothing else', () => {
    const card = { name: 'Changed Card', typeLine: 'Artifact' } as OracleCard;
    for (const deck of decks) {
      const changed = withCard(deck, card);
      expect(changed.cards).toHaveLength(deck.cards.length);
      const replaced = deck.cards.filter((entry, index) => changed.cards[index] !== entry);
      expect(replaced.every((entry) => /Basic.*Land/.test(entry.typeLine))).toBe(true);
      expect(changed.cards.filter((entry) => entry === card)).toHaveLength(replaced.length);
      expect(replaced.length).toBe(
        Math.min(4, deck.cards.filter((entry) => /Basic.*Land/.test(entry.typeLine)).length),
      );
    }
  });
});

describe('fuzz failures', () => {
  it('fails a throw, a halt, a spent budget, the wall clock and a dead process', () => {
    expect(failureOf(played({ error: 'EngineInvariantError: at state' }), RANDOM, 1000)).toMatch(
      /^threw: EngineInvariantError/,
    );
    expect(
      failureOf(played({ halt: { reason: 'Unmodeled card', turnCap: false } }), RANDOM, 1000),
    ).toBe('halted: Unmodeled card');
    expect(failureOf(played({ budgetExhausted: true, turns: 12 }), RANDOM, 1000)).toBe(
      'decision budget exhausted at turn 12',
    );
    expect(failureOf({ kind: 'timeout' }, RANDOM, 300_000)).toBe(
      'wall clock: still running after 300s',
    );
    expect(failureOf({ kind: 'crash', message: 'OOM' }, RANDOM, 1000)).toBe(
      'the game process died: OOM',
    );
    expect(failureOf(played({}), HEURISTIC, 1000)).toBeNull();
  });

  it('holds heuristic-only games to the turn cap and the empty veto, and not random ones', () => {
    expect(failureOf(played({ halt: turnCap, winner: null }), HEURISTIC, 1000)).toBe(
      'halted: turn cap of 80 exceeded',
    );
    expect(failureOf(played({ emptyVetoes: 2 }), HEURISTIC, 1000)).toMatch(/veto .* 2 time/);
    for (const providers of [RANDOM, PROVIDER_MIXES[2]!]) {
      expect(failureOf(played({ halt: turnCap, winner: null }), providers, 1000)).toBeNull();
      expect(failureOf(played({ emptyVetoes: 2 }), providers, 1000)).toBeNull();
    }
  });
});

describe('fuzz liveness', () => {
  it('lists the card ops that only ever exited early across games, most runs first', () => {
    const reply = (ops: FuzzReply['ops'], exits: FuzzReply['exits'] = []) =>
      (played({ ops, exits }) as Extract<Outcome, { kind: 'played' }>).reply;
    const report = liveness([
      reply(
        [
          { card: 'Bolt', op: 'dealDamage', runs: 2, earlyExits: 2 },
          { card: 'Bear', op: 'draw', runs: 1, earlyExits: 1 },
        ],
        [{ site: 'resolve.ref.targetIllegal', reason: 'targetIllegal', count: 2 }],
      ),
      reply(
        [
          { card: 'Bolt', op: 'dealDamage', runs: 1, earlyExits: 1 },
          { card: 'Bear', op: 'draw', runs: 2, earlyExits: 0 },
        ],
        [{ site: 'resolve.ref.targetIllegal', reason: 'targetIllegal', count: 1 }],
      ),
    ]);
    expect(report.onlyEarlyExits).toEqual([{ card: 'Bolt', op: 'dealDamage', runs: 3 }]);
    expect(report.exits).toEqual([
      { site: 'resolve.ref.targetIllegal', reason: 'targetIllegal', count: 3 },
    ]);
  });
});
