/**
 * Self-play measurement for table diplomacy (ADR 0035 decision 21): diplomacy seats against plain
 * heuristic seats on the same seeds, before deals are offered anywhere by default.
 *
 *   bun run diplomacy-sweep [--games N] [--seed S] [--turn-cap N] [--game-timeout SECONDS]
 *                           [--all] [--no-deals] [--talk] [--oracle-fixture FILE] [--json out.json]
 *
 * Two seats negotiate and two play the plain bot; which pair alternates by game, so each arm
 * holds the first-player seat half the time (as in `combat-sweep`). `--all` makes every seat a
 * diplomat instead, which measures how the table behaves rather than who wins. `--no-deals` keeps
 * the diplomacy seats' threat-aware attack targets but makes no deals: run it beside the default
 * to tell what deals add from what the targeting does. `--talk` prints each game's table talk.
 *
 * Card data comes from the Scryfall bulk file when it exists, otherwise from the committed
 * coverage fixture, so the sweep runs offline. Each game runs in a child process with a wall-clock
 * kill, as in `combat-sweep`: some seeded games slow sharply in their later turns with or without
 * diplomacy, and the timeout only decides whether a game is counted, never its result.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OracleCard, PlayerId } from '@mtg/shared';
import { describeMessage, type DiplomacyStats } from '@mtg/bot';
import { toOracleCard, type RawScryfallCard } from '../cards/scryfall';
import { buildSupportedPool, type SupportedPool } from '../cards/pool';
import { generateCommanderDeck } from '../decks/generate';
// Type-only: `diplomacy-game.ts` is also an entry point, and the games run in child processes.
import type { DiplomacyGameRequest, DiplomacyGameResult } from './diplomacy-game';

const BULK_PATH = 'data/scryfall-oracle-cards.json';
const FIXTURE_PATH = 'packages/server/fixtures/coverage-oracle.json';
const SEATS = 4;
const GAME_RUNNER = fileURLToPath(new URL('./diplomacy-game.ts', import.meta.url));

type GameOutcome =
  | { kind: 'played'; result: DiplomacyGameResult }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string };

function runGameInChild(request: DiplomacyGameRequest, timeoutMs: number): GameOutcome {
  const payloadPath = join(tmpdir(), `mtg-diplomacy-${process.pid}-${request.seed}.json`);
  writeFileSync(payloadPath, JSON.stringify(request), 'utf8');
  let child;
  try {
    child = spawnSync('bun', [GAME_RUNNER, payloadPath], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
  } finally {
    rmSync(payloadPath, { force: true });
  }
  if (child.signal !== null) return { kind: 'timeout' };
  if (child.status !== 0) {
    const stderr = (child.stderr ?? '').trim();
    const first = stderr
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('error:') || line.includes('Error:'));
    return { kind: 'error', message: first ?? (stderr.slice(0, 200) || 'child exited nonzero') };
  }
  try {
    return { kind: 'played', result: JSON.parse(child.stdout) as DiplomacyGameResult };
  } catch {
    return { kind: 'error', message: 'child produced unparseable output' };
  }
}

interface Args {
  games: number;
  seed: string;
  turnCap: number;
  gameTimeoutMs: number;
  all: boolean;
  noDeals: boolean;
  talk: boolean;
  oracleFixture?: string;
  json?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    games: 12,
    seed: 'diplomacy',
    turnCap: 200,
    gameTimeoutMs: 120_000,
    all: false,
    noDeals: false,
    talk: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--games') args.games = Math.max(1, Number.parseInt(argv[++i] ?? '', 10) || 12);
    else if (arg === '--seed') args.seed = argv[++i] ?? args.seed;
    else if (arg === '--turn-cap') {
      args.turnCap = Math.max(1, Number.parseInt(argv[++i] ?? '', 10) || args.turnCap);
    } else if (arg === '--game-timeout') {
      const seconds = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(seconds) && seconds > 0) args.gameTimeoutMs = seconds * 1000;
    } else if (arg === '--all') args.all = true;
    else if (arg === '--no-deals') args.noDeals = true;
    else if (arg === '--talk') args.talk = true;
    else if (arg === '--oracle-fixture') {
      const value = argv[++i];
      if (value !== undefined) args.oracleFixture = value;
    } else if (arg === '--json') {
      const value = argv[++i];
      if (value !== undefined) args.json = value;
    }
  }
  return args;
}

function loadPool(args: Args): SupportedPool {
  const fixture = args.oracleFixture ?? (existsSync(resolve(BULK_PATH)) ? null : FIXTURE_PATH);
  if (fixture !== null) {
    console.log(`Loading oracle fixture from ${fixture} …`);
    const parsed: unknown = JSON.parse(readFileSync(resolve(fixture), 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`Expected a JSON array of cards in "${fixture}".`);
    return buildSupportedPool(parsed as OracleCard[]);
  }
  console.log(`Loading oracle data from ${BULK_PATH} …`);
  const parsed: unknown = JSON.parse(readFileSync(resolve(BULK_PATH), 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`Expected a JSON array in "${BULK_PATH}".`);
  const cards: OracleCard[] = [];
  for (const raw of parsed as RawScryfallCard[]) {
    const card = toOracleCard(raw);
    if (card !== null) cards.push(card);
  }
  return buildSupportedPool(cards);
}

interface Totals {
  games: number;
  diplomacyWins: number;
  plainWins: number;
  draws: number;
  halted: number;
  timedOut: number;
  errored: number;
  errors: string[];
  turns: number;
  deals: DiplomacyStats;
  /** Why deals ended other than kept, and why breakers said they broke them. */
  reasons: Record<string, number>;
}

function addStats(into: DiplomacyStats, from: DiplomacyStats): void {
  into.proposals += from.proposals;
  into.accepted += from.accepted;
  into.counters += from.counters;
  into.kept += from.kept;
  into.broken += from.broken;
  into.voided += from.voided;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const pool = loadPool(args);
  const totals: Totals = {
    games: 0,
    diplomacyWins: 0,
    plainWins: 0,
    draws: 0,
    halted: 0,
    timedOut: 0,
    errored: 0,
    errors: [],
    turns: 0,
    deals: { proposals: 0, accepted: 0, counters: 0, kept: 0, broken: 0, voided: 0 },
    reasons: {},
  };

  for (let game = 0; game < args.games; game++) {
    const seed = `${args.seed}-g${game}`;
    const decks = Array.from({ length: SEATS }, (_, i) =>
      generateCommanderDeck(pool, { seed: `${seed}-seat${i + 1}` }),
    );
    const diplomats: PlayerId[] = args.all
      ? ['P1', 'P2', 'P3', 'P4']
      : game % 2 === 0
        ? ['P1', 'P3']
        : ['P2', 'P4'];

    totals.games++;
    let outcome: string;
    const run = runGameInChild(
      {
        seed,
        turnCap: args.turnCap,
        diplomacySeats: diplomats,
        negotiate: !args.noDeals,
        decks: decks.map((deck) => ({ commander: deck.commander, cards: deck.cards })),
      },
      args.gameTimeoutMs,
    );
    if (run.kind === 'played') {
      const result = run.result;
      totals.turns += result.turns;
      addStats(totals.deals, result.stats);
      for (const m of result.messages) {
        const key =
          m.kind === 'breach'
            ? `breach:${m.reason ?? 'unstated'}`
            : m.kind === 'dealEnded' && m.outcome === 'void'
              ? `void:${m.reason ?? 'unstated'}`
              : null;
        if (key !== null) totals.reasons[key] = (totals.reasons[key] ?? 0) + 1;
      }
      if (result.halted) totals.halted++;
      if (result.winner === null) {
        totals.draws++;
        outcome = 'draw';
      } else if (diplomats.includes(result.winner)) {
        totals.diplomacyWins++;
        outcome = `${result.winner} (diplomacy)`;
      } else {
        totals.plainWins++;
        outcome = `${result.winner} (plain)`;
      }
      const s = result.stats;
      console.log(
        `  game ${game + 1}/${args.games}: ${outcome}, ${result.turns} turns, ` +
          `${s.proposals} proposed, ${s.accepted} accepted, ${s.kept} kept, ${s.broken} broken, ${s.voided} void`,
      );
      if (args.talk) {
        for (const m of result.messages)
          console.log(`      [turn ${m.turn}] ${describeMessage(m)}`);
      }
    } else if (run.kind === 'timeout') {
      totals.timedOut++;
      console.log(`  game ${game + 1}/${args.games}: TIMEOUT`);
    } else {
      totals.errored++;
      if (!totals.errors.includes(run.message)) totals.errors.push(run.message);
      console.log(`  game ${game + 1}/${args.games}: THREW ${run.message}`);
    }
    if (args.json !== undefined) {
      mkdirSync(dirname(resolve(args.json)), { recursive: true });
      writeFileSync(resolve(args.json), `${JSON.stringify({ args, totals }, null, 2)}\n`, 'utf8');
    }
  }

  const played = totals.games - totals.errored - totals.timedOut;
  console.log('\nDiplomacy sweep (ADR 0035)');
  console.log('─'.repeat(26));
  console.log(
    `  ${totals.games} games, seed prefix "${args.seed}", ${args.all ? 'all seats negotiate' : '2 diplomacy seats vs 2 plain seats'}${args.noDeals ? ' (no deals: threat-aware targets only)' : ''}`,
  );
  if (!args.all) {
    console.log(`  diplomacy wins: ${totals.diplomacyWins}`);
    console.log(`  plain wins:     ${totals.plainWins}`);
  }
  console.log(
    `  draws: ${totals.draws}, halted: ${totals.halted}, timed out: ${totals.timedOut}, errored: ${totals.errored}`,
  );
  console.log(`  average turns: ${played === 0 ? '-' : (totals.turns / played).toFixed(1)}`);
  const d = totals.deals;
  console.log(
    `  deals: ${d.proposals} proposed, ${d.accepted} accepted (${d.counters} counters), ` +
      `${d.kept} kept, ${d.broken} broken, ${d.voided} void`,
  );
  const reasons = Object.entries(totals.reasons)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k} ${v}`);
  if (reasons.length > 0) console.log(`  reasons: ${reasons.join(', ')}`);
  for (const error of totals.errors) console.log(`  error: ${error}`);
}

main();
