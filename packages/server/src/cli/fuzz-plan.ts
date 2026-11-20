/**
 * What `bun run fuzz` plays and how it judges a game (ADR 0034 decision 8): the coverage decks,
 * each seed's pod, a changed card's substitution and the failure rules. `fuzz.ts` runs the games.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { buildOracleIndexFromCards } from '../cards/oracle-index';
import { resolveDeck } from '../decks/resolve';
import { importDeck } from '../decks/source';
import type { FuzzDeck, FuzzProvider, FuzzReply } from './fuzz-game';

const DECK_DIR = 'packages/server/fixtures/coverage-decks';
const ORACLE = 'packages/server/fixtures/coverage-oracle.json';
/** Basic lands a changed card replaces in each deck. */
const SUBSTITUTIONS = 4;

export async function loadDecks(): Promise<FuzzDeck[]> {
  const index = buildOracleIndexFromCards(JSON.parse(readFileSync(ORACLE, 'utf8')) as OracleCard[]);
  const decks: FuzzDeck[] = [];
  for (const file of readdirSync(DECK_DIR)
    .filter((name) => name.endsWith('.txt'))
    .sort()) {
    const label = basename(file, '.txt');
    const { resolved, unresolvedNames } = resolveDeck(
      await importDeck(readFileSync(join(DECK_DIR, file), 'utf8')),
      index,
    );
    if (resolved === null) throw new Error(`${label}: unresolved ${unresolvedNames.join(', ')}`);
    if (resolved.commanders.length === 0) throw new Error(`${label} has no commander`);
    decks.push({
      label,
      commanders: resolved.commanders,
      cards: [
        ...(resolved.companion === null ? [] : [resolved.companion]),
        ...resolved.cards.flatMap((entry) =>
          Array.from({ length: entry.quantity }, () => entry.card),
        ),
      ],
    });
  }
  return decks;
}

export const PROVIDER_MIXES: FuzzProvider[][] = [
  ['heuristic', 'heuristic', 'heuristic', 'heuristic'],
  ['random', 'random', 'random', 'random'],
  ['heuristic', 'random', 'heuristic', 'random'],
];

/** Seed N's pod: four distinct decks, picked by the seed's hash, and its provider mix. */
export function pod(
  decks: FuzzDeck[],
  n: number,
): { decks: FuzzDeck[]; providers: FuzzProvider[] } {
  const hash = createHash('sha256').update(`fuzz-${n}`).digest();
  const pool = [...decks];
  const chosen: FuzzDeck[] = [];
  for (let seat = 0; seat < 4; seat++)
    chosen.push(pool.splice(hash.readUInt32BE(seat * 4) % pool.length, 1)[0]!);
  return { decks: chosen, providers: PROVIDER_MIXES[n % PROVIDER_MIXES.length]! };
}

const isBasicLand = (card: OracleCard) => /\bBasic\b.*\bLand\b/.test(card.typeLine);

/** The deck with `card` in place of up to `SUBSTITUTIONS` of its basic lands. */
export function withCard(deck: FuzzDeck, card: OracleCard): FuzzDeck {
  let left = SUBSTITUTIONS;
  return {
    ...deck,
    cards: deck.cards.map((entry) => (left > 0 && isBasicLand(entry) && left-- > 0 ? card : entry)),
  };
}

export type Outcome =
  { kind: 'played'; reply: FuzzReply } | { kind: 'timeout' } | { kind: 'crash'; message: string };

/**
 * Why a game failed, or null. Random players seldom finish a game, so a pod with one plays to
 * the turn cap; heuristic bots finish theirs, and a heuristic-only game that reaches the cap, or
 * whose bot's veto excluded every candidate, fails.
 */
export function failureOf(
  outcome: Outcome,
  providers: readonly FuzzProvider[],
  timeoutMs: number,
): string | null {
  if (outcome.kind === 'timeout') return `wall clock: still running after ${timeoutMs / 1000}s`;
  if (outcome.kind === 'crash') return `the game process died: ${outcome.message}`;
  const { reply } = outcome;
  const heuristicOnly = providers.every((provider) => provider === 'heuristic');
  if (reply.error !== null) return `threw: ${reply.error}`;
  // A draw the final state confirms is a result, not a failure (`verifyDraw`).
  if (
    reply.halt !== null &&
    reply.halt.draw === undefined &&
    (!reply.halt.turnCap || heuristicOnly)
  )
    return `halted: ${reply.halt.reason}${reply.halt.site === undefined ? '' : ` at ${reply.halt.site}`}`;
  if (reply.budgetExhausted) return `decision budget exhausted at turn ${reply.turns}`;
  if (reply.emptyVetoes > 0 && heuristicOnly)
    return `the heuristic bot's veto excluded every candidate ${reply.emptyVetoes} time(s)`;
  return null;
}

/**
 * The liveness report (ADR 0034 decision 8): across the games played, each card's ops that ran
 * and only ever exited early, most runs first, and how often each early-exit site fired. An op
 * that never acts is either a card that cannot do its job in these pods or a guard to look at.
 */
export function liveness(replies: readonly FuzzReply[]): {
  onlyEarlyExits: Array<{ card: string; op: string; runs: number }>;
  exits: Array<{ site: string; reason: string; count: number }>;
} {
  const ops = new Map<string, { card: string; op: string; runs: number; earlyExits: number }>();
  const exits = new Map<string, { site: string; reason: string; count: number }>();
  for (const reply of replies) {
    for (const run of reply.ops) {
      const key = `${run.card}\u0000${run.op}`;
      const entry = ops.get(key) ?? { card: run.card, op: run.op, runs: 0, earlyExits: 0 };
      entry.runs += run.runs;
      entry.earlyExits += run.earlyExits;
      ops.set(key, entry);
    }
    for (const exit of reply.exits) {
      const key = `${exit.site}\u0000${exit.reason}`;
      const entry = exits.get(key) ?? { site: exit.site, reason: exit.reason, count: 0 };
      entry.count += exit.count;
      exits.set(key, entry);
    }
  }
  return {
    onlyEarlyExits: [...ops.values()]
      .filter((entry) => entry.earlyExits === entry.runs)
      .map(({ card, op, runs }) => ({ card, op, runs }))
      .sort((a, b) => b.runs - a.runs || a.card.localeCompare(b.card) || a.op.localeCompare(b.op)),
    exits: [...exits.values()].sort((a, b) => b.count - a.count || a.site.localeCompare(b.site)),
  };
}
