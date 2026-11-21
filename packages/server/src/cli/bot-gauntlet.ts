/**
 * Bot gauntlet: does a new bot do better than the old one at a table of different decks, against
 * the old bot? A mirror league (`bot-league --deck`) only shows whether a bot beats itself; this
 * measures it in the field.
 *
 * Each pod seats four different premade decks, all played by the old bot, and is played once as
 * that baseline. Then, for each new arm and each seat, the same pod (same seed, same decks, same
 * seats) is played again with only that seat switched to the new arm. Each (pod, seat) is a pair:
 * the seat's result under the old bot and under the new one, at the same table. A pod costs
 * 1 + 4 × (new arms) games.
 *
 *   bun run bot-gauntlet [--pods N] [--seed S] [--old ARM] [--new ARM,ARM] [--decks a,b,...]
 *                        [--turn-cap N] [--jobs N] [--timeout-ms N] [--trace-dir DIR]
 *                        [--json out.json] [--resume]
 *
 * A deck-styled arm (`styled`, `proxy-v2-styled`) plays each deck in the style
 * `fixtures/deck-styles.json` pins for it, not the classifier's guess.
 *
 * `--resume` reuses the rows (`out.rows.jsonl`) a stopped run with the same `--json` wrote, and
 * plays only the games missing from them. It refuses rows saved under a different seed, old arm,
 * turn cap or pod schedule (`out.config.json`).
 *
 * `--trace-dir` keeps a compact trace of each game (`game-trace.ts`): every seat in a baseline
 * game, the switched seat in the others, for reviewing where the bots' play differed.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { OracleCard, PlayStyle } from '@mtg/shared';
import { styleForDeck } from '../ai/play-style';
import type { LeagueGameRequest } from './bot-league-game';
import { armFor, premadeDeck, runInChild, type Outcome } from './bot-league';

interface Args {
  pods: number;
  seed: string;
  old: string;
  new: string[];
  decks?: string[];
  turnCap: number;
  jobs: number;
  timeoutMs: number;
  traceDir?: string;
  json?: string;
  /** Keep the games a stopped run with the same `--json` already played. */
  resume: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    pods: 20,
    seed: 'gauntlet',
    old: 'fixed-0043',
    new: ['fixed', 'styled'],
    turnCap: 120,
    jobs: 4,
    timeoutMs: 300_000,
    resume: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    const list = () => (next ?? '').split(',').filter((s) => s.length > 0);
    switch (argv[i]) {
      case '--pods':
        args.pods = Number(next);
        break;
      case '--seed':
        if (next !== undefined) args.seed = next;
        break;
      case '--old':
        if (next !== undefined) args.old = next;
        break;
      case '--new':
        args.new = list();
        break;
      case '--decks':
        args.decks = list();
        break;
      case '--turn-cap':
        args.turnCap = Number(next);
        break;
      case '--jobs':
        args.jobs = Number(next);
        break;
      case '--timeout-ms':
        args.timeoutMs = Number(next);
        break;
      case '--trace-dir':
        if (next !== undefined) args.traceDir = next;
        break;
      case '--resume':
        args.resume = true;
        continue;
      case '--json':
        if (next !== undefined) args.json = next;
        break;
      default:
        continue;
    }
    i++;
  }
  for (const arm of [args.old, ...args.new]) armFor(arm);
  return args;
}

const DECK_DIRS = [
  'packages/server/fixtures/coverage-decks',
  'packages/server/fixtures/archetype-decks',
];

/** The style each test deck is built for; the classifier's guess for any deck not listed. */
const STYLES = 'packages/server/fixtures/deck-styles.json';

type Deck = { name: string; commander: OracleCard; cards: OracleCard[]; style: PlayStyle };

async function loadDecks(names: string[] | undefined): Promise<Deck[]> {
  const all =
    names ??
    DECK_DIRS.flatMap((dir) =>
      readdirSync(resolve(dir))
        .filter((f) => f.endsWith('.txt'))
        .map((f) => f.slice(0, -4)),
    );
  const pinned = JSON.parse(readFileSync(resolve(STYLES), 'utf8')) as Record<string, string>;
  const decks: Deck[] = [];
  for (const name of all) {
    try {
      const deck = await premadeDeck(name);
      const style = (pinned[name] as PlayStyle | undefined) ?? styleForDeck(deck);
      decks.push({ name, ...deck, style });
    } catch (error) {
      console.log(`skipping deck ${name}: ${(error as Error).message}`);
    }
  }
  if (decks.length < 4) throw new Error('the gauntlet needs at least four decks');
  return decks;
}

/** A small seeded generator, so a pod schedule replays from its seed. */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pods of four different decks, every deck seated about equally often, seats shuffled. */
function schedule(decks: Deck[], pods: number, seed: string): Deck[][] {
  const random = rng(seed);
  const shuffled = (): Deck[] => {
    const out = [...decks];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  const stream: Deck[] = [];
  const result: Deck[][] = [];
  while (result.length < pods) {
    if (stream.length < 8) stream.push(...shuffled());
    const pod: Deck[] = [];
    for (let i = 0; i < stream.length && pod.length < 4;) {
      if (pod.includes(stream[i]!)) i++;
      else pod.push(...stream.splice(i, 1));
    }
    result.push(pod);
  }
  return result;
}

/**
 * What a run's rows depend on, saved beside them (`<json>.config.json`) so `--resume` cannot pair
 * rows from one experiment with games from another. The new arms are not part of it: rows are
 * keyed by arm name, so adding an arm resumes cleanly. More pods are fine too, because the schedule
 * is drawn in order and the earlier pods do not change.
 */
export interface RunConfig {
  seed: string;
  old: string;
  turnCap: number;
  /** Each pod's decks, by seat. */
  schedule: string[][];
}

export function runConfig(
  args: Pick<Args, 'seed' | 'old' | 'turnCap'>,
  pods: ReadonlyArray<ReadonlyArray<{ name: string }>>,
): RunConfig {
  return {
    seed: args.seed,
    old: args.old,
    turnCap: args.turnCap,
    schedule: pods.map((pod) => pod.map((deck) => deck.name)),
  };
}

/** Why rows saved under `saved` cannot be resumed as `current`, or null when they can. */
export function resumeConflict(saved: RunConfig | null, current: RunConfig): string | null {
  if (saved === null)
    return 'the saved rows have no recorded configuration; rerun without --resume';
  for (const key of ['seed', 'old', 'turnCap'] as const)
    if (saved[key] !== current[key])
      return `${key} was ${String(saved[key])}, now ${String(current[key])}`;
  const shared = Math.min(saved.schedule.length, current.schedule.length);
  for (let pod = 0; pod < shared; pod++)
    if (saved.schedule[pod]!.join(',') !== current.schedule[pod]!.join(','))
      return `pod ${pod} seated ${saved.schedule[pod]!.join(', ')}, now ${current.schedule[pod]!.join(', ')}`;
  return null;
}

interface Row {
  pod: number;
  seed: string;
  decks: string[];
  styles: PlayStyle[];
  /** `base`, or the new arm switched into `hero`. */
  game: string;
  hero: number | null;
  outcome: 'win' | 'draw' | 'halted' | 'timeout' | 'error';
  winnerSeat: number | null;
  life: number[];
  turns: number;
  /** Wall-clock time of the game, for spotting slow tables. */
  ms?: number;
  note?: string;
}

function rowFor(
  pod: number,
  seed: string,
  decks: Deck[],
  game: string,
  hero: number | null,
  outcome: Outcome,
): Row {
  const base = {
    pod,
    seed,
    decks: decks.map((d) => d.name),
    styles: decks.map((d) => d.style),
    game,
    hero,
  };
  if (outcome.kind !== 'played')
    return {
      ...base,
      outcome: outcome.kind,
      winnerSeat: null,
      life: [],
      turns: 0,
      ...(outcome.kind === 'error' && { note: outcome.message }),
    };
  const reply = outcome.reply;
  return {
    ...base,
    outcome: reply.halted ? 'halted' : reply.winner === null ? 'draw' : 'win',
    winnerSeat: reply.winner === null ? null : Number(reply.winner.slice(1)) - 1,
    life: [0, 1, 2, 3].map((i) => Math.max(0, reply.life[`P${i + 1}`] ?? 0)),
    turns: reply.turns,
    ms: reply.ms,
    ...(reply.halted && { note: reply.haltReason ?? '' }),
  };
}

interface Paired {
  pairs: number;
  oldWins: number;
  newWins: number;
  /** Pairs the new arm won and the old lost, and the reverse. */
  newOnly: number;
  oldOnly: number;
  oldRate: number;
  newRate: number;
  /** Sign test on the discordant pairs. */
  z: number;
  lifeShareDelta: number;
}

function share(row: Row, seat: number): number {
  const total = row.life.reduce((s, l) => s + l, 0);
  return total > 0 ? row.life[seat]! / total : 0;
}

function paired(pairs: Array<{ old: Row; new: Row; seat: number }>): Paired {
  const counted = (r: Row) => r.outcome === 'win' || r.outcome === 'draw';
  const usable = pairs.filter((p) => counted(p.old) && counted(p.new));
  let oldWins = 0;
  let newWins = 0;
  let newOnly = 0;
  let oldOnly = 0;
  let life = 0;
  for (const p of usable) {
    const o = p.old.winnerSeat === p.seat;
    const n = p.new.winnerSeat === p.seat;
    if (o) oldWins++;
    if (n) newWins++;
    if (n && !o) newOnly++;
    if (o && !n) oldOnly++;
    life += share(p.new, p.seat) - share(p.old, p.seat);
  }
  const n = Math.max(1, usable.length);
  const discordant = newOnly + oldOnly;
  return {
    pairs: usable.length,
    oldWins,
    newWins,
    newOnly,
    oldOnly,
    oldRate: Number((oldWins / n).toFixed(3)),
    newRate: Number((newWins / n).toFixed(3)),
    z: discordant === 0 ? 0 : Number(((newOnly - oldOnly) / Math.sqrt(discordant)).toFixed(2)),
    lifeShareDelta: Number((life / n).toFixed(3)),
  };
}

function summarize(rows: Row[], args: Args) {
  const base = new Map(rows.filter((r) => r.game === 'base').map((r) => [r.pod, r]));
  const out: Record<string, unknown> = {};
  for (const arm of args.new) {
    const pairs = rows
      .filter((r) => r.game === arm && r.hero !== null && base.has(r.pod))
      .map((r) => ({ old: base.get(r.pod)!, new: r, seat: r.hero! }));
    const by = (key: (p: (typeof pairs)[number]) => string) => {
      const groups = new Map<string, typeof pairs>();
      for (const p of pairs) groups.set(key(p), [...(groups.get(key(p)) ?? []), p]);
      return Object.fromEntries(
        [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, paired(v)]),
      );
    };
    out[arm] = {
      overall: paired(pairs),
      byStyle: by((p) => p.new.styles[p.seat]!),
      byDeck: by((p) => p.new.decks[p.seat]!),
    };
  }
  const outcomes: Record<string, number> = {};
  for (const r of rows) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  return {
    old: args.old,
    new: args.new,
    pods: args.pods,
    games: rows.length,
    outcomes,
    meanTurns: Number(
      (
        rows.filter((r) => r.turns > 0).reduce((s, r) => s + r.turns, 0) /
        Math.max(1, rows.filter((r) => r.turns > 0).length)
      ).toFixed(1),
    ),
    arms: out,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const decks = await loadDecks(args.decks);
  console.log(`decks: ${decks.map((d) => `${d.name} (${d.style})`).join(', ')}`);
  const old = armFor(args.old);
  const arms = args.new.map(armFor);
  if (args.traceDir !== undefined) mkdirSync(args.traceDir, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'bot-gauntlet-'));
  const rowsPath = args.json?.replace(/\.json$/, '') + '.rows.jsonl';
  const pods = schedule(decks, args.pods, args.seed);

  type Job = { pod: number; game: string; hero: number | null; request: LeagueGameRequest };
  const jobs: Job[] = [];
  pods.forEach((pod, p) => {
    const seed = `${args.seed}-${p}`;
    const request = (seats: (typeof old)[], game: string, traced: number[]) => ({
      seed,
      turnCap: args.turnCap,
      seats,
      decks: pod.map((d) => ({ commander: d.commander, cards: d.cards })),
      ...(args.traceDir !== undefined && {
        trace: {
          path: join(args.traceDir, `pod${p}-${game}.jsonl`),
          seats: traced.map((i) => `P${i + 1}`),
        },
      }),
    });
    jobs.push({
      pod: p,
      game: 'base',
      hero: null,
      request: request([old, old, old, old], 'base', [0, 1, 2, 3]),
    });
    for (const arm of arms)
      for (let hero = 0; hero < 4; hero++) {
        const seats = [old, old, old, old];
        // A deck-styled arm plays the style the deck is built for (`deck-styles.json`).
        seats[hero] =
          arm.styleFromDeck === true
            ? { ...arm, styleFromDeck: false, pinnedStyle: pod[hero]!.style }
            : arm;
        jobs.push({
          pod: p,
          game: arm.name,
          hero,
          request: request(seats, `${arm.name}-P${hero + 1}`, [hero]),
        });
      }
  });

  // `--resume`: keep the rows a stopped run already wrote and play only the games it did not.
  const rows: Row[] = [];
  const done = new Set<string>();
  const jobKey = (pod: number, game: string, hero: number | null) => `${pod}/${game}/${hero}`;
  const configPath = args.json?.replace(/\.json$/, '') + '.config.json';
  const config = runConfig(args, pods);
  if (args.resume && args.json !== undefined && existsSync(rowsPath)) {
    const saved = existsSync(configPath)
      ? (JSON.parse(readFileSync(configPath, 'utf8')) as RunConfig)
      : null;
    const conflict = resumeConflict(saved, config);
    if (conflict !== null) throw new Error(`--resume: ${conflict}`);
    for (const line of readFileSync(rowsPath, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      const row = JSON.parse(line) as Row;
      if (row.seed !== `${args.seed}-${row.pod}`) continue;
      rows.push(row);
      done.add(jobKey(row.pod, row.game, row.hero));
    }
    console.log(`resuming: ${rows.length} games already played`);
  } else if (args.json !== undefined) {
    writeFileSync(rowsPath, '');
  }
  if (args.json !== undefined) writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  const todo = jobs.filter((job) => !done.has(jobKey(job.pod, job.game, job.hero)));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length) {
      const n = next++;
      const job = todo[n]!;
      const outcome = await runInChild(job.request, args.timeoutMs, dir, n);
      const row = rowFor(job.pod, job.request.seed, pods[job.pod]!, job.game, job.hero, outcome);
      rows.push(row);
      if (args.json !== undefined) appendFileSync(rowsPath, `${JSON.stringify(row)}\n`);
      console.log(
        `pod ${job.pod} ${job.game}${job.hero === null ? '' : ` P${job.hero + 1}`}: ${row.outcome}` +
          `${row.winnerSeat === null ? '' : ` P${row.winnerSeat + 1}`} (${row.turns} turns)` +
          `${row.note ? ` ${row.note}` : ''}`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, args.jobs) }, worker));
  rmSync(dir, { recursive: true, force: true });

  rows.sort(
    (a, b) => a.pod - b.pod || a.game.localeCompare(b.game) || (a.hero ?? -1) - (b.hero ?? -1),
  );
  const summary = summarize(rows, args);
  console.log(JSON.stringify(summary, null, 2));
  if (args.json !== undefined) {
    writeFileSync(args.json, JSON.stringify({ args, summary, rows }, null, 2));
  }
}

const entryPoint = process.argv[1];
// `import.meta.path` is Bun's; under the test runner the module is only imported, never run.
const modulePath = (import.meta as { path?: string }).path;
if (
  entryPoint !== undefined &&
  modulePath !== undefined &&
  existsSync(entryPoint) &&
  resolve(entryPoint) === resolve(modulePath)
)
  void main();
