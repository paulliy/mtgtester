/**
 * Engine CPU benchmark and determinism check over the fuzz pods.
 *
 *   bun run engine-bench [--from N] [--games N] [--turn-cap N] [--mix heuristic|all]
 *                        [--json PATH] [--compare PATH]
 *
 * Plays seeded four-player games in this process, with no invariant checker, and reports the time
 * spent inside the engine (`advance` and `submit`) apart from the providers. Each game also gets a
 * fingerprint: a SHA-256 over every decision request the engine surfaced (with its full option
 * menu), every response, and the final event log. A performance change to legal-action generation
 * must leave every fingerprint unchanged: `--json` writes them, and `--compare` fails when any
 * differs from a saved run, when nothing was compared, or when a saved seed in the played range
 * was skipped.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { playGame, type GameRun } from './engine-bench-game';
import { loadDecks, pod } from './fuzz-plan';

interface Args {
  from: number;
  games: number;
  turnCap: number;
  heuristicOnly: boolean;
  json: string | null;
  compare: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    from: 0,
    games: 6,
    turnCap: 20,
    heuristicOnly: true,
    json: null,
    compare: null,
  };
  // A count that is not a whole number would play no games, and an empty run compares as a pass.
  const count = (flag: string, text: string, min: number): number => {
    const parsed = Number(text);
    if (!Number.isSafeInteger(parsed) || parsed < min || text.trim() === '')
      throw new Error(`${flag} takes a whole number of at least ${min}`);
    return parsed;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => argv[++i] ?? '';
    if (arg === '--from') args.from = count(arg, value(), 0);
    else if (arg === '--games') args.games = count(arg, value(), 1);
    else if (arg === '--turn-cap') args.turnCap = count(arg, value(), 1);
    else if (arg === '--mix') args.heuristicOnly = value() !== 'all';
    else if (arg === '--json') args.json = value();
    else if (arg === '--compare') args.compare = value();
    else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const decks = await loadDecks();
  const runs: GameRun[] = [];
  let seed = args.from;
  while (runs.length < args.games) {
    const plan = pod(decks, seed);
    if (!args.heuristicOnly || plan.providers.every((kind) => kind === 'heuristic')) {
      const run = playGame(seed, plan.decks, plan.providers, args.turnCap);
      runs.push(run);
      console.log(
        `seed ${run.seed}: ${run.turns} turns, ${run.decisions} decisions, engine ${run.engineMs} ms, ` +
          `providers ${run.providerMs} ms, ${run.outcome}, ${run.fingerprint}`,
      );
    }
    seed++;
  }
  const engineMs = runs.reduce((sum, run) => sum + run.engineMs, 0);
  const decisions = runs.reduce((sum, run) => sum + run.decisions, 0);
  console.log(
    `total: engine ${engineMs} ms over ${decisions} decisions ` +
      `(${(engineMs / Math.max(1, decisions)).toFixed(2)} ms per decision)`,
  );
  if (args.json !== null) writeFileSync(args.json, JSON.stringify(runs, null, 2));
  if (args.compare !== null) {
    const saved = JSON.parse(readFileSync(args.compare, 'utf8')) as GameRun[];
    const played = new Map(runs.map((run) => [run.seed, run.fingerprint]));
    const first = Math.min(...runs.map((run) => run.seed));
    const last = Math.max(...runs.map((run) => run.seed));
    const compared = saved.filter((run) => played.has(run.seed));
    const differ = compared.filter((run) => played.get(run.seed) !== run.fingerprint);
    // A saved seed inside the played range that this run skipped means the pods or the mix
    // differ, so the runs are not comparable even where seeds overlap.
    const missing = saved.filter(
      (run) => run.seed >= first && run.seed <= last && !played.has(run.seed),
    );
    console.log(
      `compare: ${compared.length - differ.length}/${compared.length} fingerprints match`,
    );
    if (differ.length > 0) console.log(`differ: seeds ${differ.map((run) => run.seed).join(', ')}`);
    if (missing.length > 0)
      console.log(`not played: saved seeds ${missing.map((run) => run.seed).join(', ')}`);
    if (compared.length === 0) console.log('compare: no saved seed was played, nothing compared');
    if (differ.length > 0 || missing.length > 0 || compared.length === 0) process.exitCode = 1;
  }
}

await main();
