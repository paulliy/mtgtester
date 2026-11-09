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
 * differs from a saved run.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { DecisionResponse, PlayerId } from '@mtg/shared';
import { Engine, RandomDecisionProvider, type DecisionProvider } from '@mtg/engine';
import { HeuristicDecisionProvider } from '@mtg/bot';
import { TABLE_ENGINE_LIMITS } from '../match/engine-limits';
import { loadDecks, pod } from './fuzz-plan';
import type { FuzzDeck, FuzzProvider } from './fuzz-game';

interface Args {
  from: number;
  games: number;
  turnCap: number;
  heuristicOnly: boolean;
  json: string | null;
  compare: string | null;
}

interface GameRun {
  seed: number;
  turns: number;
  decisions: number;
  engineMs: number;
  providerMs: number;
  outcome: string;
  fingerprint: string;
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
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => argv[++i] ?? '';
    if (arg === '--from') args.from = Number.parseInt(value(), 10);
    else if (arg === '--games') args.games = Number.parseInt(value(), 10);
    else if (arg === '--turn-cap') args.turnCap = Number.parseInt(value(), 10);
    else if (arg === '--mix') args.heuristicOnly = value() !== 'all';
    else if (arg === '--json') args.json = value();
    else if (arg === '--compare') args.compare = value();
    else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

function playGame(
  seed: number,
  decks: FuzzDeck[],
  providerKinds: FuzzProvider[],
  turnCap: number,
): GameRun {
  const seedText = `fuzz-${seed}`;
  const engine = new Engine(
    {
      gameId: 'bench',
      seed: seedText,
      turnCap,
      players: decks.map((deck, seat) => ({
        id: `P${seat + 1}`,
        deckId: deck.label,
        commanders: deck.commanders,
        cards: deck.cards,
      })),
    },
    TABLE_ENGINE_LIMITS,
  );
  const providers = new Map<PlayerId, DecisionProvider>();
  const providerFor = (seat: PlayerId): DecisionProvider => {
    let provider = providers.get(seat);
    if (provider === undefined) {
      const index = Number(seat.slice(1)) - 1;
      provider =
        providerKinds[index] === 'random'
          ? new RandomDecisionProvider(`${seedText}-${seat}`)
          : new HeuristicDecisionProvider(`${seedText}-${seat}`, () => engine.view(seat));
      providers.set(seat, provider);
    }
    return provider;
  };
  const hash = createHash('sha256');
  let engineMs = 0;
  let providerMs = 0;
  let decisions = 0;
  let outcome = 'running';
  try {
    for (;;) {
      let t = performance.now();
      const step = engine.advance();
      engineMs += performance.now() - t;
      if (step.kind === 'gameOver') {
        outcome = step.result.halted
          ? `halted: ${step.result.haltReason ?? ''}`
          : `winner ${step.result.winnerSeat ?? 'none'}`;
        break;
      }
      if (step.kind === 'continue') continue;
      decisions++;
      hash.update(JSON.stringify(step.request));
      t = performance.now();
      const response: DecisionResponse = providerFor(step.request.decidingPlayer).decide(
        step.request,
      );
      providerMs += performance.now() - t;
      hash.update(JSON.stringify(response));
      t = performance.now();
      engine.submit(response);
      engineMs += performance.now() - t;
    }
  } catch (error) {
    outcome = `error: ${error instanceof Error ? error.message : String(error)}`;
  }
  hash.update(JSON.stringify(engine.eventsSince(0)));
  hash.update(outcome);
  return {
    seed,
    turns: engine.getState().turnNumber,
    decisions,
    engineMs: Math.round(engineMs),
    providerMs: Math.round(providerMs),
    outcome,
    fingerprint: hash.digest('hex').slice(0, 16),
  };
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
    const bySeed = new Map(saved.map((run) => [run.seed, run.fingerprint]));
    const differ = runs.filter(
      (run) => bySeed.has(run.seed) && bySeed.get(run.seed) !== run.fingerprint,
    );
    const compared = runs.filter((run) => bySeed.has(run.seed)).length;
    console.log(`compare: ${compared - differ.length}/${compared} fingerprints match`);
    if (differ.length > 0) {
      console.log(`differ: seeds ${differ.map((run) => run.seed).join(', ')}`);
      process.exitCode = 1;
    }
  }
}

await main();
