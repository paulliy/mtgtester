/**
 * The multi-seed measurement loop and bound sweep for ADR 0024's combat search (sub-phase 7c).
 *
 * ADR 0024 states a success criterion and then names the one piece of tooling it needs to check
 * it: "bun run play-decks runs exactly one seeded game per invocation and reports no aggregate. A
 * multi-seed loop that runs N games across both arms and prints win rate and per-decision timing
 * is a thin script over the existing CLI, and it is the only new tooling this ADR requires."
 * This is that script.
 *
 *   bun run combat-sweep [--games N] [--seed S] [--top-k 4,8,16] [--max-attackers 6,10]
 *                        [--max-permanents 8,12] [--turn-cap N] [--game-timeout SECONDS]
 *                        [--json out.json] [--verbose]
 *
 * ## How the arms are compared
 *
 * Both arms play in the SAME game, on the same seed, from the same decks: two seats run the
 * search, two run the Phase 4 static heuristic. That is what "head-to-head" has to mean here —
 * running four search bots in one game and four static bots in another gives two populations with
 * no common opponent and no way to attribute a win.
 *
 * Seat assignment alternates by game index, so each arm holds the first-player seat exactly half
 * the time. Turn order is worth a great deal in Commander and would otherwise swamp the effect
 * being measured.
 *
 * Everything is deterministic: same seed, same decks, same result, every run (ADR item 6). The two
 * arms diverge only where the search actually chooses differently from the heuristic, so a
 * difference in outcome is attributable and needs no statistical machinery beyond enough games.
 *
 * ## Reading the output
 *
 * Win rate is the headline, but on its own it cannot distinguish "this bound does nothing" from
 * "this bound binds and does not help" — opposite problems with opposite fixes. So each row also
 * reports how often the search actually ran (`engaged`) and what it cost per decision. A
 * configuration whose engagement is unchanged from the previous one did not really get tested.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OracleCard, PlayerId } from '@mtg/shared';
import type { CombatSearchOptions } from '@mtg/bot';
import { toOracleCard, type RawScryfallCard } from '../cards/scryfall';
import { buildSupportedPool, type SupportedPool } from '../cards/pool';
import { generateCommanderDeck } from '../decks/generate';
// TYPE-ONLY, and it has to stay that way: `combat-sweep-game.ts` is an entry point that runs a
// game on import, so a value import here would execute it in the parent process with the parent's
// argv. `verbatimModuleSyntax` guarantees `import type` emits nothing at all.
import type { ArmCounters, GameReply, GameRequest } from './combat-sweep-game';

const BULK_PATH = 'data/scryfall-oracle-cards.json';
const SEATS = 4;
const DEFAULT_TURN_CAP = 200;
/** Wall-clock kill for one game. Generous: it is a stuck-game guard, not a performance budget. */
const DEFAULT_GAME_TIMEOUT_MS = 90_000;

interface Args {
  games: number;
  seed: string;
  topK: number[];
  maxAttackers: number[];
  maxPermanents: number[];
  json?: string;
  turnCap: number;
  gameTimeoutMs: number;
  verbose: boolean;
}

function numberList(raw: string | undefined, fallback: number[]): number[] {
  if (raw === undefined) return fallback;
  const parsed = raw
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parsed.length > 0 ? parsed : fallback;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    games: 24,
    seed: 'sweep',
    topK: [],
    maxAttackers: [],
    maxPermanents: [],
    turnCap: DEFAULT_TURN_CAP,
    gameTimeoutMs: DEFAULT_GAME_TIMEOUT_MS,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--games') {
      const parsed = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) args.games = parsed;
    } else if (arg === '--seed') args.seed = argv[++i] ?? args.seed;
    else if (arg === '--top-k') args.topK = numberList(argv[++i], []);
    else if (arg === '--max-attackers') args.maxAttackers = numberList(argv[++i], []);
    else if (arg === '--max-permanents') args.maxPermanents = numberList(argv[++i], []);
    else if (arg === '--json') {
      const val = argv[++i];
      if (val !== undefined) args.json = val;
    } else if (arg === '--turn-cap') {
      const parsed = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) args.turnCap = parsed;
    } else if (arg === '--game-timeout') {
      const parsed = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) args.gameTimeoutMs = parsed * 1000;
    } else if (arg === '--verbose' || arg === '-v') args.verbose = true;
  }
  return args;
}

function loadPool(): SupportedPool {
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

/** Per-arm tallies for one configuration, accumulated across every game in the run. */
type ArmStats = ArmCounters;

const emptyArm = (): ArmStats => ({
  wins: 0,
  combatDecisionMs: 0,
  combatDecisions: 0,
  totalMs: 0,
  totalDecisions: 0,
  blockSearched: 0,
  blockDeclined: 0,
  splitSearched: 0,
  splitDeclined: 0,
});

function addCounters(into: ArmStats, from: ArmCounters): void {
  into.wins += from.wins;
  into.combatDecisionMs += from.combatDecisionMs;
  into.combatDecisions += from.combatDecisions;
  into.totalMs += from.totalMs;
  into.totalDecisions += from.totalDecisions;
  into.blockSearched += from.blockSearched;
  into.blockDeclined += from.blockDeclined;
  into.splitSearched += from.splitSearched;
  into.splitDeclined += from.splitDeclined;
}

interface ConfigResult {
  label: string;
  options: CombatSearchOptions;
  search: ArmStats;
  control: ArmStats;
  games: number;
  halted: number;
  drawn: number;
  errored: number;
  timedOut: number;
  /** One message per distinct failure, so a card bug gets named rather than merely counted. */
  errors: string[];
  totalTurns: number;
}

const GAME_RUNNER = fileURLToPath(new URL('./combat-sweep-game.ts', import.meta.url));

type GameResult =
  { kind: 'played'; reply: GameReply } | { kind: 'timeout' } | { kind: 'error'; message: string };

/**
 * Run one game in a child process, killed if it outlives `timeoutMs`.
 *
 * The isolation is not incidental: a game can spin inside a single `Engine.advance()` call, and
 * synchronous JavaScript cannot be interrupted from the same process no matter what guard is
 * armed. `combat-sweep-game.ts` explains which real games did that. The wall clock lives here and
 * only ever decides whether a result is COUNTED — never what any result is — so the games
 * themselves stay reproducible from their seeds alone (brief 4, 5.9).
 */
function runGameInChild(request: GameRequest, timeoutMs: number): GameResult {
  // Payload by file, not stdin: `bun run` does not reliably forward stdin on Windows, and four
  // decks of `OracleCard` are far past any argv limit.
  const payloadPath = join(tmpdir(), `mtg-sweep-${process.pid}-${request.seed}.json`);
  writeFileSync(payloadPath, JSON.stringify(request), 'utf8');
  let child;
  try {
    child = spawnSync('bun', [GAME_RUNNER, payloadPath], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
    });
  } finally {
    rmSync(payloadPath, { force: true });
  }

  if (child.error !== undefined && (child.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    return { kind: 'timeout' };
  }
  if (child.signal !== null) return { kind: 'timeout' };
  if (child.status !== 0) {
    const stderr = (child.stderr ?? '').trim();
    // The engine's own messages are the useful part; bun's stack frames are not.
    const first = stderr
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('error:') || line.includes('Error:'));
    return { kind: 'error', message: first ?? stderr.slice(0, 200) ?? 'child exited nonzero' };
  }
  try {
    return { kind: 'played', reply: JSON.parse(child.stdout) as GameReply };
  } catch {
    return { kind: 'error', message: 'child produced unparseable output' };
  }
}

/**
 * Write results to `args.json` if one was asked for.
 *
 * Called after every game, not only at the end. A 1400-game run died at game 1210 with no message
 * — a long sequence of process spawns eventually exhausts something the OS is not obliged to
 * explain — and because the file was only written on completion, all 1210 games went with it.
 * Rewriting a few kilobytes per game is far cheaper than a lost hour.
 */
function writeResults(args: Args, results: ConfigResult[]): void {
  if (args.json === undefined) return;
  mkdirSync(dirname(resolve(args.json)), { recursive: true });
  writeFileSync(resolve(args.json), `${JSON.stringify({ args, results }, null, 2)}\n`, 'utf8');
}

function runConfig(
  pool: SupportedPool,
  args: Args,
  label: string,
  options: CombatSearchOptions,
  done: ConfigResult[],
): ConfigResult {
  const out: ConfigResult = {
    label,
    options,
    search: emptyArm(),
    control: emptyArm(),
    games: 0,
    halted: 0,
    drawn: 0,
    errored: 0,
    timedOut: 0,
    errors: [],
    totalTurns: 0,
  };

  for (let game = 0; game < args.games; game++) {
    const seed = `${args.seed}-g${game}`;
    const decks = Array.from({ length: SEATS }, (_, i) =>
      generateCommanderDeck(pool, { seed: `${seed}-seat${i + 1}` }),
    );
    // Alternate which pair of seats searches, so each arm gets the first-player seat half the
    // time. Turn order matters enormously in Commander and would otherwise dominate the signal.
    const searchSeats: ReadonlySet<PlayerId> =
      game % 2 === 0 ? new Set(['P1', 'P3']) : new Set(['P2', 'P4']);

    // A game that throws or hangs is one data point, not a reason to lose the other 359. Both
    // outcomes are recorded and reported rather than swallowed: they have all been real bugs so
    // far, and a silent skip would have hidden every one of them.
    const outcome = runGameInChild(
      {
        seed,
        turnCap: args.turnCap,
        searchSeats: [...searchSeats],
        options,
        decks: decks.map((deck) => ({ commander: deck.commander, cards: deck.cards })),
      },
      args.gameTimeoutMs,
    );

    out.games++;
    let label2 = 'THREW';
    if (outcome.kind === 'played') {
      addCounters(out.search, outcome.reply.search);
      addCounters(out.control, outcome.reply.control);
      out.totalTurns += outcome.reply.turns;
      if (outcome.reply.halted) out.halted++;
      if (outcome.reply.winner === null) out.drawn++;
      label2 =
        outcome.reply.winner === null
          ? 'draw'
          : searchSeats.has(outcome.reply.winner)
            ? 'search'
            : 'control';
    } else if (outcome.kind === 'timeout') {
      out.timedOut++;
      label2 = 'TIMEOUT';
    } else {
      out.errored++;
      if (!out.errors.includes(outcome.message)) out.errors.push(outcome.message);
    }

    writeResults(args, [...done, out]);

    if (args.verbose) {
      const turns = outcome.kind === 'played' ? outcome.reply.turns : 0;
      const winner = outcome.kind === 'played' ? (outcome.reply.winner ?? '-') : '-';
      process.stdout.write(
        `    ${label} game ${game + 1}/${args.games}: ${winner} (${label2}), ${turns} turns\n`,
      );
    } else {
      process.stdout.write(`\r    ${label}: ${game + 1}/${args.games} games`);
    }
  }
  if (!args.verbose) process.stdout.write('\n');
  return out;
}

const perDecision = (arm: ArmStats): number =>
  arm.combatDecisions === 0 ? 0 : arm.combatDecisionMs / arm.combatDecisions;

const engagement = (arm: ArmStats): string => {
  const total = arm.blockSearched + arm.blockDeclined;
  if (total === 0) return '—';
  return `${((arm.blockSearched / total) * 100).toFixed(0)}% (${arm.blockSearched}/${total})`;
};

function report(results: ConfigResult[], args: Args): void {
  console.log('\nCombat search sweep (ADR 0024 sub-phase 7c)');
  console.log('─'.repeat(42));
  console.log(
    `  ${args.games} games per configuration, seed prefix "${args.seed}", 2 search seats vs 2 control seats\n`,
  );

  const header = [
    'configuration'.padEnd(26),
    'search'.padStart(7),
    'control'.padStart(8),
    'win%'.padStart(7),
    'engaged'.padStart(14),
    'ms/combat'.padStart(10),
    'marginal'.padStart(9),
  ].join('  ');
  console.log(`  ${header}`);
  console.log(`  ${'─'.repeat(header.length)}`);

  for (const r of results) {
    const decided = r.search.wins + r.control.wins;
    const winPct = decided === 0 ? 0 : (r.search.wins / decided) * 100;
    console.log(
      `  ${r.label.padEnd(26)}  ${String(r.search.wins).padStart(7)}  ${String(r.control.wins).padStart(8)}` +
        `  ${`${winPct.toFixed(1)}%`.padStart(7)}  ${engagement(r.search).padStart(14)}` +
        `  ${perDecision(r.search).toFixed(3).padStart(10)}` +
        `  ${(perDecision(r.search) - perDecision(r.control)).toFixed(3).padStart(9)}`,
    );
  }

  const timedOut = results.reduce((n, r) => n + r.timedOut, 0);
  if (timedOut > 0) {
    console.log(
      `\n  ${timedOut} game(s) exceeded the ${(args.gameTimeoutMs / 1000).toFixed(0)}s per-game limit and are excluded.` +
        '\n  Each is a game that never terminates, not a slow one. Re-run a single seed under' +
        '\n  `--verbose` to identify it.',
    );
  }

  const errored = results.reduce((n, r) => n + r.errored, 0);
  if (errored > 0) {
    console.log(
      `\n  ${errored} game(s) threw and are excluded from the tallies. Distinct failures:`,
    );
    const seen = new Set<string>();
    for (const r of results) {
      for (const e of r.errors) {
        if (seen.has(e)) continue;
        seen.add(e);
        console.log(`    ${e}`);
      }
    }
  }

  const anyHalted = results.reduce((n, r) => n + r.halted, 0);
  const anyDrawn = results.reduce((n, r) => n + r.drawn, 0);
  console.log(
    `\n  Control arm costs ${perDecision(results[0]?.control ?? emptyArm()).toFixed(3)} ms per combat` +
      ' decision; "marginal" is what the search adds on top of that.',
  );
  const games = results.reduce((n, r) => n + r.games, 0);
  const turns = results.reduce((n, r) => n + r.totalTurns, 0);
  console.log(
    `  ${anyHalted} halted, ${anyDrawn} without a winner, ${(turns / Math.max(1, games)).toFixed(1)} turns per game` +
      ` (cap ${args.turnCap}), across all configurations.`,
  );
  // One standard error on a proportion, in percentage points. Stated because the alternative is
  // reading a 55% row as a win when it is noise: determinism makes this measurement exactly
  // REPRODUCIBLE, which is not at all the same as making it precise.
  const stderrPct = (Math.sqrt(0.25 / Math.max(1, args.games)) * 100).toFixed(0);
  console.log(
    "\n  win% is the search arm's share of decided games. 50% is the null in expectation only:" +
      '\n  a configuration that never changes a decision still lands wherever the seat-and-deck' +
      '\n  lottery puts it, not on 50% exactly. What determinism buys is reproducibility — the' +
      '\n  same seeds give the same games every run — not a tighter interval.' +
      `\n  At ${args.games} games one standard error is about ${stderrPct} points, so read` +
      `\n  anything within ~${stderrPct} of 50% as unresolved rather than as a result.`,
  );

  if (args.json !== undefined) {
    writeResults(args, results);
    console.log(`\n  Wrote ${args.json}`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const pool = loadPool();
  console.log(`Pool: ${pool.cards.length.toLocaleString()} modeled cards.`);

  const configs: { label: string; options: CombatSearchOptions }[] = [
    { label: 'shipped defaults', options: {} },
  ];
  for (const topK of args.topK) configs.push({ label: `topK=${topK}`, options: { topK } });
  for (const n of args.maxAttackers) {
    configs.push({ label: `maxAttackers=${n}`, options: { maxAttackers: n } });
  }
  for (const n of args.maxPermanents) {
    configs.push({ label: `maxPermanents=${n}`, options: { maxCombatPermanents: n } });
  }

  const results: ConfigResult[] = [];
  for (const { label, options } of configs) {
    results.push(runConfig(pool, args, label, options, [...results]));
  }
  report(results, args);
}

main();
