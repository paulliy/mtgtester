/**
 * Seeded four-player fuzz games with the state invariants on (ADR 0034 decision 8).
 *
 *   bun run fuzz [--from N] [--games N] [--card "<name>"]... [--changed [--base SHA]]
 *                [--card-games N] [--turn-cap N] [--decisions N] [--game-timeout SECONDS]
 *                [--jobs N] [--json PATH] [--report PATH] [--liveness PATH]
 *
 * Seed N maps to a fixed pod: four of the committed coverage decks, resolved against the pinned
 * `coverage-oracle.json` (the bulk file is gitignored), and a provider mix: heuristic bots in every
 * seat, random players in every seat, or two of each. The decks are used as committed; fuzz tests
 * the engine, not deck legality. Each changed card (`--card`, or `--changed`: the cards whose
 * definition snapshot changed since `--base`, or HEAD's parent) is read from the pin store, or for
 * a promoted compiled card from its EDHREC pin, and
 * plays `--card-games` more pods in which it replaces up to four basic lands in every deck.
 *
 * A game fails on a thrown error or invariant violation, a halted result (an unmodeled card, the
 * table's step and object limits), an exhausted decision budget or the wall clock; a
 * heuristic-only game also fails on the turn cap and on the bot's empty-veto fallback
 * (`fuzz-plan.ts`). Each failure prints the command that replays it, and `--report` writes the
 * failures as Markdown for an issue. The per-game time is reported, with the liveness report
 * (`--liveness` writes it whole): each card's ops that only ever exited early. The exit code is 1
 * when any game failed.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OracleCard } from '@mtg/shared';
import { compiledCards } from '../../../engine/src/cards/overrides/compiled/register';
import { pinStore } from '../../../engine/tests/scenario/pin-store';
import { baseCommit, changedCards } from '../../../../scripts/cards/changed-cards';
import { PINNED_ORACLE_PATH, type PinnedCard } from '../cards/edhrec-pins';
import type { FuzzReply, FuzzRequest } from './fuzz-game';
import { failureOf, liveness, loadDecks, pod, withCard, type Outcome } from './fuzz-plan';

const GAME = fileURLToPath(new URL('./fuzz-game.ts', import.meta.url));

interface Args {
  from: number;
  games: number;
  cards: string[];
  changed: boolean;
  base: string | undefined;
  cardGames: number;
  turnCap: number;
  decisions: number;
  timeoutMs: number;
  jobs: number;
  json: string | null;
  report: string | null;
  liveness: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    from: 0,
    games: 12,
    cards: [],
    changed: false,
    base: undefined,
    cardGames: 3,
    turnCap: 80,
    decisions: 20_000,
    timeoutMs: 300_000,
    jobs: 2,
    json: null,
    report: null,
    liveness: null,
  };
  const count = (flag: string, value: string | undefined): number => {
    const parsed = Number.parseInt(value ?? '', 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${flag} takes a count`);
    return parsed;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => argv[++i];
    if (arg === '--from') args.from = count(arg, value());
    else if (arg === '--games') args.games = count(arg, value());
    else if (arg === '--card') args.cards.push(value() ?? '');
    else if (arg === '--changed') args.changed = true;
    else if (arg === '--base') args.base = value();
    else if (arg === '--card-games') args.cardGames = count(arg, value());
    else if (arg === '--turn-cap') args.turnCap = count(arg, value());
    else if (arg === '--decisions') args.decisions = count(arg, value());
    else if (arg === '--game-timeout') args.timeoutMs = count(arg, value()) * 1000;
    else if (arg === '--jobs') args.jobs = Math.max(1, count(arg, value()));
    else if (arg === '--json') args.json = value() ?? null;
    else if (arg === '--report') args.report = value() ?? null;
    else if (arg === '--liveness') args.liveness = value() ?? null;
    else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

interface Game {
  n: number;
  card: string | null;
  request: FuzzRequest;
}

/** One game in a child process, killed if it outlives `timeoutMs`. */
function runGame(game: Game, dir: string, timeoutMs: number): Promise<Outcome> {
  const path = join(dir, `${game.request.seed.replace(/[^\w-]/g, '_')}.json`);
  writeFileSync(path, JSON.stringify(game.request));
  return new Promise((done) => {
    const child = spawn('bun', [GAME, path], {
      env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return done({ kind: 'timeout' });
      if (code !== 0)
        return done({ kind: 'crash', message: stderr.trim().slice(-2000) || `exit ${code}` });
      try {
        done({ kind: 'played', reply: JSON.parse(stdout) as FuzzReply });
      } catch {
        done({ kind: 'crash', message: `unparseable reply: ${stdout.slice(0, 200)}` });
      }
    });
  });
}

function replay(game: Game, args: Args): string {
  const card =
    game.card === null
      ? '--card-games 0'
      : `--card ${JSON.stringify(game.card)} --games 0 --card-games 1`;
  return `bun run fuzz --from ${game.n} ${game.card === null ? '--games 1 ' : ''}${card} --turn-cap ${args.turnCap} --decisions ${args.decisions}`;
}

/** The pinned Oracle record of every promoted compiled card, by name. */
function compiledCardPins(): Map<string, OracleCard> {
  const promoted = new Set([...compiledCards().values()].map((card) => card.name));
  if (promoted.size === 0) return new Map();
  const pins = JSON.parse(readFileSync(resolve(PINNED_ORACLE_PATH), 'utf8')) as PinnedCard[];
  return new Map(
    pins.filter((pin) => promoted.has(pin.card.name)).map((pin) => [pin.card.name, pin.card]),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const decks = await loadDecks();
  const names = [...args.cards];
  // A promoted compiled card has no pin-store entry: its Oracle record is its EDHREC pin.
  const compiled = compiledCardPins();
  const hasPin = (name: string): boolean => pinStore.has(name) || compiled.has(name);
  const pinOf = (name: string): OracleCard =>
    pinStore.has(name) ? pinStore.get(name) : compiled.get(name)!;
  if (args.changed)
    names.push(
      ...changedCards(baseCommit(args.base), [...pinStore.names(), ...compiled.keys()]).filter(
        (name) => !names.includes(name),
      ),
    );
  const unpinned = names.filter((name) => !hasPin(name));
  if (unpinned.length > 0)
    console.log(`fuzz: not in the pin store, so not played: ${unpinned.join('; ')}`);

  const games: Game[] = [];
  const request = (n: number, seed: string, picked: ReturnType<typeof pod>): FuzzRequest => ({
    seed,
    providers: picked.providers,
    decks: picked.decks,
    turnCap: args.turnCap,
    maxDecisions: args.decisions,
  });
  for (let n = args.from; n < args.from + args.games; n++)
    games.push({ n, card: null, request: request(n, `fuzz-${n}`, pod(decks, n)) });
  for (const name of names.filter(hasPin)) {
    const card = pinOf(name);
    for (let n = args.from; n < args.from + args.cardGames; n++) {
      const picked = pod(decks, n);
      games.push({
        n,
        card: name,
        request: request(n, `fuzz-${n}-${name}`, {
          ...picked,
          decks: picked.decks.map((deck) => withCard(deck, card)),
        }),
      });
    }
  }

  const dir = mkdtempSync(join(tmpdir(), 'mtg-fuzz-'));
  const results: Array<{ game: Game; outcome: Outcome; failure: string | null }> = [];
  const started = performance.now();
  try {
    let next = 0;
    const worker = async () => {
      while (next < games.length) {
        const game = games[next++]!;
        const outcome = await runGame(game, dir, args.timeoutMs);
        const failure = failureOf(outcome, game.request.providers, args.timeoutMs);
        results.push({ game, outcome, failure });
        const what = `${game.request.seed} [${game.request.providers.join(' ')}] ${game.request.decks.map((deck) => deck.label).join(', ')}`;
        if (outcome.kind === 'played') {
          const { reply } = outcome;
          const end = reply.winner === null ? 'no winner' : `${reply.winner} won`;
          console.log(
            `${failure === null ? 'ok  ' : 'FAIL'} ${what}: ${end}, turn ${reply.turns}, ${reply.decisions} decisions, ${(reply.ms / 1000).toFixed(1)}s`,
          );
        } else console.log(`FAIL ${what}`);
        if (failure !== null)
          console.log(
            `     ${failure.replaceAll('\n', '\n     ')}\n     replay: ${replay(game, args)}`,
          );
      }
    };
    await Promise.all(Array.from({ length: Math.min(args.jobs, games.length) }, worker));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const times = results
    .flatMap(({ outcome }) => (outcome.kind === 'played' ? [outcome.reply.ms] : []))
    .sort((a, b) => a - b);
  const failed = results.filter(({ failure }) => failure !== null);
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  console.log(
    `fuzz: ${results.length} game(s), ${failed.length} failed; per game median ${seconds(times[Math.floor(times.length / 2)] ?? 0)}, max ${seconds(times.at(-1) ?? 0)}; ${seconds(performance.now() - started)} in all with ${args.jobs} job(s)`,
  );
  const live = liveness(
    results.flatMap(({ outcome }) => (outcome.kind === 'played' ? [outcome.reply] : [])),
  );
  console.log(
    `liveness: ${live.onlyEarlyExits.length} card op(s) ran and only ever exited early${live.onlyEarlyExits
      .slice(0, 10)
      .map(({ card, op, runs }) => `\n  ${card}: ${op} (${runs} run${runs === 1 ? '' : 's'})`)
      .join('')}`,
  );
  if (args.liveness !== null) writeFileSync(args.liveness, `${JSON.stringify(live, null, 2)}\n`);
  if (args.json !== null)
    writeFileSync(
      args.json,
      `${JSON.stringify(
        results.map(({ game, outcome, failure }) => ({
          seed: game.request.seed,
          card: game.card,
          providers: game.request.providers,
          decks: game.request.decks.map((deck) => deck.label),
          outcome: outcome.kind === 'played' ? outcome.reply : outcome,
          failure,
          replay: failure === null ? undefined : replay(game, args),
        })),
        null,
        2,
      )}\n`,
    );
  if (args.report !== null)
    writeFileSync(
      args.report,
      [
        `${failed.length} of ${results.length} fuzz game(s) failed.`,
        '',
        ...failed.flatMap(({ game, failure }) => [
          `### ${game.request.seed}`,
          '',
          `- Seats: ${game.request.decks.map((deck, seat) => `P${seat + 1} ${deck.label} (${game.request.providers[seat]})`).join(', ')}`,
          ...(game.card === null ? [] : [`- Changed card: ${game.card}`]),
          `- Replay: \`${replay(game, args)}\``,
          '',
          '```',
          failure!,
          '```',
          '',
        ]),
      ].join('\n'),
    );
  if (failed.length > 0) process.exitCode = 1;
}

await main();
