/**
 * Bot league (ADR 0039): two bot configurations play seeded four-player games against each other,
 * two seats each, and the run reports wins, draws and end-of-game life share per arm.
 *
 * Each seed is played twice with the arms swapped between seat pairs, so deck and seat luck cancel
 * within a pair. Games run in child processes (`bot-league-game.ts`) under a wall-clock kill, a
 * few at a time.
 *
 *   bun run bot-league [--games N] [--seed S] [--a ARM] [--b ARM] [--turn-cap N] [--jobs N]
 *                      [--timeout-ms N] [--deck NAME] [--json out.json]
 *
 * `--deck NAME` seats one premade deck (`fixtures/coverage-decks/NAME.txt`) in all four seats, so
 * the arms play a mirror and differ only in how they play it: the way to test a play style on a
 * deck built for it. Without it every seat gets its own generated deck.
 *
 * ARM is one of the presets in `ARMS` below.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OracleCard, PlayStyle } from '@mtg/shared';
import { DEFAULT_POLICY_FIXES, POLICY_FIXES } from '@mtg/bot';
import { buildSupportedPool, type SupportedPool } from '../cards/pool';
import { generateCommanderDeck } from '../decks/generate';
import { buildOracleIndexFromCards } from '../cards/oracle-index';
import { resolveDeck } from '../decks/resolve';
import { importDeck } from '../decks/source';
import { DEFAULT_AI_CONFIG } from '../ai/config';
import type { WakeRule } from '../ai/steering';
// Type-only: the game module runs a game when it is the entry point.
import type { LeagueArm, LeagueGameReply, LeagueGameRequest } from './bot-league-game';

const FIXTURE = 'packages/server/fixtures/coverage-oracle.json';

/** One arm per ADR 0043 fix: the card-aware bot plus that fix alone. */
const FIX_ARMS: Record<string, LeagueArm> = Object.fromEntries(
  POLICY_FIXES.map((fix) => [`fix-${fix}`, { name: `fix-${fix}`, knowledge: true, fixes: [fix] }]),
);

/**
 * Arms without `fixes` play the bot as it was before ADR 0043, so the numbers recorded against
 * them keep holding. `fixed` is the production bot: card-aware with every default fix.
 */
export const ARMS: Record<string, LeagueArm> = {
  legacy: { name: 'legacy', legacy: true },
  policy: { name: 'policy' },
  knowledge: { name: 'knowledge', knowledge: true },
  fixed: { name: 'fixed', knowledge: true, fixes: [...DEFAULT_POLICY_FIXES] },
  // The production bot as ADR 0043 left it, before `scarceAnswer` and `faceDamage`: their gate.
  'fixed-0043': {
    name: 'fixed-0043',
    knowledge: true,
    fixes: DEFAULT_POLICY_FIXES.filter((fix) => fix !== 'scarceAnswer' && fix !== 'faceDamage'),
  },
  ...FIX_ARMS,
  aggro: { name: 'aggro', knowledge: true, steering: { aggression: 0.85 } },
  control: {
    name: 'control',
    knowledge: true,
    steering: { aggression: 0.3, holdUpMana: 2, avoidOverextending: true },
  },
  // Play styles (`BotSteering.style`): each preset on its own, and the style the deck's archetype
  // implies, with no strategist and under the proxy strategist.
  'style-aggro': styleArm('aggro'),
  'style-control': styleArm('control'),
  'style-combo': styleArm('combo'),
  styled: {
    name: 'styled',
    knowledge: true,
    fixes: [...DEFAULT_POLICY_FIXES],
    styleFromDeck: true,
  },
  // Hill-climb S7: the production bot steered by the proxy strategist, under each wake schedule.
  'proxy-every-turn': proxyArm('proxy-every-turn', 'everyTurn', 'table-v1'),
  'proxy-v1': proxyArm('proxy-v1', 'onChange', 'table-v1'),
  'proxy-v2': proxyArm('proxy-v2', 'onChange', 'table-v2'),
  'proxy-v2-styled': {
    ...proxyArm('proxy-v2-styled', 'onChange', 'table-v2'),
    styleFromDeck: true,
  },
};

function styleArm(style: PlayStyle): LeagueArm {
  return {
    name: `style-${style}`,
    knowledge: true,
    fixes: [...DEFAULT_POLICY_FIXES],
    steering: { style },
  };
}

function proxyArm(name: string, replan: 'everyTurn' | 'onChange', rule: WakeRule): LeagueArm {
  return {
    name,
    knowledge: true,
    fixes: [...DEFAULT_POLICY_FIXES],
    proxy: { replan, rule, maxReuseTurns: DEFAULT_AI_CONFIG.strategistMaxReuseTurns },
  };
}

interface Args {
  games: number;
  seed: string;
  a: string;
  b: string;
  turnCap: number;
  jobs: number;
  timeoutMs: number;
  deck?: string;
  json?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    games: 20,
    seed: 'league',
    a: 'knowledge',
    b: 'legacy',
    turnCap: 120,
    jobs: 4,
    timeoutMs: 180_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    switch (argv[i]) {
      case '--games':
        args.games = Number(next);
        i++;
        break;
      case '--seed':
        args.seed = next ?? args.seed;
        i++;
        break;
      case '--a':
        args.a = next ?? args.a;
        i++;
        break;
      case '--b':
        args.b = next ?? args.b;
        i++;
        break;
      case '--turn-cap':
        args.turnCap = Number(next);
        i++;
        break;
      case '--jobs':
        args.jobs = Number(next);
        i++;
        break;
      case '--timeout-ms':
        args.timeoutMs = Number(next);
        i++;
        break;
      case '--deck':
        if (next !== undefined) args.deck = next;
        i++;
        break;
      case '--json':
        if (next !== undefined) args.json = next;
        i++;
        break;
      default:
        throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  for (const arm of [args.a, args.b]) {
    if (ARMS[arm] === undefined) {
      throw new Error(`unknown arm ${arm}; choose from ${Object.keys(ARMS).join(', ')}`);
    }
  }
  return args;
}

/** A premade coverage deck by file name, for a mirror (`--deck`). One commander only. */
async function premadeDeck(name: string): Promise<{ commander: OracleCard; cards: OracleCard[] }> {
  const index = buildOracleIndexFromCards(
    JSON.parse(readFileSync(resolve(FIXTURE), 'utf8')) as OracleCard[],
  );
  const path = resolve('packages/server/fixtures/coverage-decks', `${name}.txt`);
  const { resolved, unresolvedNames } = resolveDeck(
    await importDeck(readFileSync(path, 'utf8')),
    index,
  );
  if (resolved === null)
    throw new Error(`--deck ${name}: unresolved ${unresolvedNames.join(', ')}`);
  if (resolved.commanders.length !== 1)
    throw new Error(
      `--deck ${name}: ${resolved.commanders.length} commanders; the league seats one`,
    );
  return {
    commander: resolved.commanders[0]!,
    cards: [
      ...(resolved.companion === null ? [] : [resolved.companion]),
      ...resolved.cards.flatMap((entry) =>
        Array.from({ length: entry.quantity }, () => entry.card),
      ),
    ],
  };
}

function loadPool(): SupportedPool {
  const cards = JSON.parse(readFileSync(resolve(FIXTURE), 'utf8')) as OracleCard[];
  return buildSupportedPool(cards);
}

const GAME_RUNNER = fileURLToPath(new URL('./bot-league-game.ts', import.meta.url));

type Outcome =
  | { kind: 'played'; reply: LeagueGameReply }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string };

function runInChild(
  request: LeagueGameRequest,
  timeoutMs: number,
  dir: string,
  n: number,
): Promise<Outcome> {
  const payload = join(dir, `game-${n}.json`);
  writeFileSync(payload, JSON.stringify(request));
  return new Promise((done) => {
    const child = spawn('bun', [GAME_RUNNER, payload], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL') return done({ kind: 'timeout' });
      if (code !== 0) {
        // The thrown message, not the tail of the stack, plus the seed to replay the game.
        const lines = err.trim().split('\n');
        const thrown = lines.find((l) => /^\s*(\w*Error|error):/.test(l)) ?? lines.at(-1) ?? '';
        return done({ kind: 'error', message: `${thrown.trim()} (seed ${request.seed})` });
      }
      try {
        done({ kind: 'played', reply: JSON.parse(out) as LeagueGameReply });
      } catch {
        done({ kind: 'error', message: `unreadable reply: ${out.slice(0, 200)}` });
      }
    });
  });
}

interface Tally {
  wins: Record<string, number>;
  lifeShare: Record<string, number>;
  draws: number;
  /** Games the engine stopped (an engine error or a budget halt): neither a win nor a draw. */
  halted: number;
  timeouts: number;
  errors: string[];
  games: number;
  turns: number;
  ms: number;
  /** Proxy strategist calls and reuses per arm, summed over played games. */
  proxyCalls: Record<string, { calls: number; reused: number }>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = loadPool();
  const armA = ARMS[args.a]!;
  const armB = ARMS[args.b]!;
  const dir = mkdtempSync(join(tmpdir(), 'bot-league-'));
  const tally: Tally = {
    wins: { [armA.name]: 0, [armB.name]: 0 },
    lifeShare: { [armA.name]: 0, [armB.name]: 0 },
    draws: 0,
    halted: 0,
    timeouts: 0,
    errors: [],
    games: 0,
    turns: 0,
    ms: 0,
    proxyCalls: {},
  };

  const mirror = args.deck === undefined ? undefined : await premadeDeck(args.deck);
  const requests: LeagueGameRequest[] = [];
  for (let g = 0; g < args.games; g++) {
    const seed = `${args.seed}-${Math.floor(g / 2)}`;
    const decks =
      mirror !== undefined
        ? [mirror, mirror, mirror, mirror]
        : Array.from({ length: 4 }, (_, i) =>
            generateCommanderDeck(pool, { seed: `${seed}-seat${i + 1}` }),
          );
    const swap = g % 2 === 1;
    const first = swap ? armB : armA;
    const second = swap ? armA : armB;
    requests.push({
      seed,
      turnCap: args.turnCap,
      seats: [first, second, first, second],
      decks: decks.map((d) => ({ commander: d.commander, cards: d.cards })),
    });
  }

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < requests.length) {
      const n = next++;
      const request = requests[n]!;
      const outcome = await runInChild(request, args.timeoutMs, dir, n);
      tally.games++;
      if (outcome.kind === 'timeout') {
        tally.timeouts++;
        console.log(`game ${n}: TIMEOUT`);
        continue;
      }
      if (outcome.kind === 'error') {
        tally.errors.push(outcome.message);
        console.log(`game ${n}: ERROR ${outcome.message}`);
        continue;
      }
      const reply = outcome.reply;
      if (reply.halted) {
        tally.halted++;
        console.log(`game ${n}: HALTED ${reply.haltReason ?? ''} (seed ${request.seed})`);
        continue;
      }
      tally.turns += reply.turns;
      tally.ms += reply.ms;
      for (const [arm, c] of Object.entries(reply.proxyCalls ?? {})) {
        const entry = (tally.proxyCalls[arm] ??= { calls: 0, reused: 0 });
        entry.calls += c.calls;
        entry.reused += c.reused;
      }
      if (reply.winnerArm === null) tally.draws++;
      else tally.wins[reply.winnerArm]!++;
      const total = Object.values(reply.life).reduce((s, l) => s + Math.max(0, l), 0);
      request.seats.forEach((arm, i) => {
        const life = Math.max(0, reply.life[`P${i + 1}`] ?? 0);
        tally.lifeShare[arm.name]! += total > 0 ? life / total : 0;
      });
      console.log(
        `game ${n}: ${reply.winnerArm ?? 'draw'} (${reply.turns} turns, ${(reply.ms / 1000).toFixed(1)}s)`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, args.jobs) }, worker));
  if (tally.errors.length === 0) rmSync(dir, { recursive: true, force: true });

  const decided = tally.wins[armA.name]! + tally.wins[armB.name]!;
  const rate = decided === 0 ? 0 : tally.wins[armA.name]! / decided;
  const ci = decided === 0 ? 0 : 1.96 * Math.sqrt((rate * (1 - rate)) / decided);
  const played = tally.games - tally.timeouts - tally.errors.length - tally.halted;
  const summary = {
    a: armA.name,
    b: armB.name,
    games: tally.games,
    decided,
    draws: tally.draws,
    halted: tally.halted,
    timeouts: tally.timeouts,
    errors: tally.errors.length,
    wins: tally.wins,
    aWinRate: Number(rate.toFixed(3)),
    aWinRate95: [
      Number(Math.max(0, rate - ci).toFixed(3)),
      Number(Math.min(1, rate + ci).toFixed(3)),
    ],
    lifeShare: Object.fromEntries(
      Object.entries(tally.lifeShare).map(([k, v]) => [
        k,
        Number((v / Math.max(1, played)).toFixed(3)),
      ]),
    ),
    meanTurns: Number((tally.turns / Math.max(1, played)).toFixed(1)),
    meanGameSeconds: Number((tally.ms / Math.max(1, played) / 1000).toFixed(1)),
    ...(Object.keys(tally.proxyCalls).length > 0 ? { proxyCalls: tally.proxyCalls } : {}),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (args.json !== undefined)
    writeFileSync(args.json, JSON.stringify({ args, summary, errors: tally.errors }, null, 2));
}

void main();
