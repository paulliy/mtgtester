/**
 * One game of the bot league (ADR 0039), run in its own process so a hung game is one data point
 * rather than a lost run (the same reasoning as `combat-sweep-game.ts`). Reads a JSON
 * `LeagueGameRequest` from the file named in `argv[2]` and writes a `LeagueGameReply` to stdout.
 */

import { readFileSync } from 'node:fs';
import { GameTrace } from './game-trace';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BotSteering, DecisionRequest, OracleCard, PlayStyle, PlayerId } from '@mtg/shared';
import { Engine, runToCompletion, type EnginePlayerConfig } from '@mtg/engine';
import { HeuristicDecisionProvider, type PolicyFix } from '@mtg/bot';
import { buildCardKnowledge } from '../ai/card-traits';
import { styleForDeck } from '../ai/play-style';
import { ProxyStrategist, type ProxySchedule } from '../ai/proxy-strategist';

/** How one seat's bot is configured. */
export interface LeagueArm {
  name: string;
  /** The pre-ADR 0039 flat scoring. */
  legacy?: boolean;
  /** Card traits from the IR. */
  knowledge?: boolean;
  /** Fixed strategist knobs for the whole game. */
  steering?: BotSteering;
  /** Knobs from the deterministic proxy strategist, asked on this schedule (hill-climb S7). */
  proxy?: ProxySchedule;
  /** ADR 0043's policy fixes. Omitted is none: the bot as it was before them. */
  fixes?: PolicyFix[];
  /** Add the seat's deck's play style (`play-style.ts`) to whatever knobs the arm sets. */
  styleFromDeck?: boolean;
  /** Add this play style to whatever knobs the arm sets (`bot-gauntlet`'s pinned deck styles). */
  pinnedStyle?: PlayStyle;
}

export interface LeagueGameRequest {
  seed: string;
  turnCap: number;
  /** Arm per seat, in seat order. */
  seats: LeagueArm[];
  decks: { commander: OracleCard; cards: OracleCard[] }[];
  /** Write a compact game trace for these seats to `path` (`bot-gauntlet --trace-dir`). */
  trace?: { path: string; seats: PlayerId[] };
}

export interface LeagueGameReply {
  winner: PlayerId | null;
  /** Arm name of the winner, or null for a draw. */
  winnerArm: string | null;
  turns: number;
  /** The engine stopped the game for a reason other than a winner, a turn cap or a mutual loss. */
  halted: boolean;
  haltReason?: string;
  /** Life of each seat at the end, 0 for an eliminated seat. */
  life: Record<PlayerId, number>;
  ms: number;
  /** Proxy strategist calls and reuses per arm name, for arms with `proxy`. */
  proxyCalls?: Record<
    string,
    { calls: number; reused: number }
  >; /** The play style each `styleFromDeck` seat was given. */
  styles?: Record<string, PlayStyle>;
}

/** The engine reports a turn cap and a simultaneous loss as halts; for the league they are draws. */
function isDrawReason(reason: string | null | undefined): boolean {
  return reason == null || /turn cap|lost simultaneously/.test(reason);
}

export function playLeagueGame(request: LeagueGameRequest): LeagueGameReply {
  const started = performance.now();
  const players: EnginePlayerConfig[] = request.decks.map((deck, i) => ({
    id: `P${i + 1}`,
    deckId: `league-${i + 1}`,
    commanders: [deck.commander],
    cards: deck.cards,
  }));
  const engine = new Engine({
    gameId: 'bot-league',
    seed: request.seed,
    players,
    turnCap: request.turnCap,
  });
  const knowledge = buildCardKnowledge(engine.cardDefinitions());
  const providers = new Map<PlayerId, HeuristicDecisionProvider>();
  const proxies = new Map<PlayerId, ProxyStrategist>();
  const styles: Record<string, PlayStyle> = {};
  const armOf = (seat: PlayerId): LeagueArm => request.seats[Number(seat.slice(1)) - 1]!;
  const providerFor = (
    seat: PlayerId,
  ): { decide: (r: DecisionRequest) => ReturnType<HeuristicDecisionProvider['decide']> } => {
    let provider = providers.get(seat);
    if (provider === undefined) {
      const arm = armOf(seat);
      let steering: (() => BotSteering | undefined) | undefined =
        arm.proxy !== undefined
          ? proxySteering(seat, arm.proxy)
          : arm.steering === undefined
            ? undefined
            : () => arm.steering;
      if (arm.styleFromDeck === true || arm.pinnedStyle !== undefined) {
        const style = arm.pinnedStyle ?? styleForDeck(request.decks[Number(seat.slice(1)) - 1]!);
        styles[seat] = style;
        const base = steering;
        steering = () => ({ ...base?.(), style });
      }
      provider = new HeuristicDecisionProvider(`${request.seed}-${seat}`, () => engine.view(seat), {
        ...(arm.legacy === true ? { legacy: true } : {}),
        ...(arm.knowledge === true ? { knowledge } : {}),
        ...(steering === undefined ? {} : { steering }),
        fixes: arm.fixes ?? [],
      });
      providers.set(seat, provider);
    }
    return provider;
  };
  function proxySteering(seat: PlayerId, schedule: ProxySchedule): () => BotSteering | undefined {
    const proxy = new ProxyStrategist(schedule);
    proxies.set(seat, proxy);
    return () => {
      const state = engine.getState();
      const active = state.players[state.activePlayerIndex]?.id;
      return proxy.knobsFor(state.turnNumber, active === seat, engine.view(seat));
    };
  }
  const trace =
    request.trace === undefined
      ? undefined
      : new GameTrace(request.trace.path, request.trace.seats, (seat) => engine.view(seat), {
          decks: request.decks.map((d) => d.commander.name),
          arms: request.seats.map((a) => a.name),
          seed: request.seed,
        });
  const result = runToCompletion(
    engine,
    providerFor,
    trace === undefined ? undefined : { onDecision: (req, res) => trace.decision(req, res) },
  );
  const proxyCalls: Record<string, { calls: number; reused: number }> = {};
  for (const [seat, proxy] of proxies) {
    const entry = (proxyCalls[armOf(seat).name] ??= { calls: 0, reused: 0 });
    entry.calls += proxy.calls;
    entry.reused += proxy.reused;
  }
  const life: Record<PlayerId, number> = {};
  for (const player of engine.getState().players) {
    life[player.id] = player.hasLost === true ? 0 : player.life;
  }
  trace?.end(result.winnerSeat, life, result.turnCount, result.haltReason ?? null);
  return {
    winner: result.winnerSeat,
    winnerArm: result.winnerSeat === null ? null : armOf(result.winnerSeat).name,
    turns: result.turnCount,
    halted: result.halted && !isDrawReason(result.haltReason),
    ...(result.haltReason ? { haltReason: result.haltReason } : {}),
    life,
    ms: Math.round(performance.now() - started),
    ...(proxies.size > 0 ? { proxyCalls } : {}),
    ...(Object.keys(styles).length > 0 ? { styles } : {}),
  };
}

function main(): void {
  const payloadPath = process.argv[2];
  if (payloadPath === undefined) throw new Error('usage: bot-league-game.ts <payload.json>');
  const reply = playLeagueGame(JSON.parse(readFileSync(payloadPath, 'utf8')) as LeagueGameRequest);
  process.stdout.write(JSON.stringify(reply));
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(import.meta.url)) {
  main();
}
