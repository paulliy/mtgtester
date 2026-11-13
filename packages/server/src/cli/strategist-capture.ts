/**
 * ADR 0045 decision 1.1: capture a bot-led game for the strategist study. Four seats play through
 * the production pipeline in bot-led mode with a strategist every turn
 * (`AI_STRATEGIST_REPLAN=everyTurn`), table diplomacy on, the strategist's tactician request in
 * shadow and every ADR 0044 trigger in shadow. The game is written as a `ReplayTranscript` plus,
 * at the first decision of every seat's turn, the knobs and deals each seat had in force.
 *
 *   bun run strategist-capture [--seed S] [--turn-cap N] [--max-usd N] [--max-calls N]
 *                              [--decks decks.json] [--no-diplomacy] [--no-flag] [--offline] [--out F]
 *
 * PAID unless `--offline`: the strategist is the one configured in `.env`, and the run stops
 * calling it once `--max-usd` (default 3) or `--max-calls` (default 400) is reached; the seats
 * keep their last knobs. `--offline` answers the strategist with fixed knobs, for free, to time
 * the bot-led game and test the pipeline. `--decks` names four decks from the coverage fixture,
 * `[{"commander": "...", "cards": ["...", ...]}, ...]`, so combos and deals can be arranged;
 * otherwise decks are generated from the seed. `--no-flag` leaves the tactician request out of the
 * strategist's primer, to compare knob quality with and without it (decision 5.5).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  BotSteering,
  DecisionRequest,
  DecisionResponse,
  OracleCard,
  PlayerId,
} from '@mtg/shared';
import { DiplomacyTable, withDiplomacyAsync, type ActiveObligation } from '@mtg/bot';
import type { Engine, GameConfig } from '@mtg/engine';
import { buildSupportedPool } from '../cards/pool';
import { generateCommanderDeck } from '../decks/generate';
import type { AiClient } from '../ai/client';
import { configForRole, ESCALATION_TRIGGERS, loadAiConfig, type AiConfig } from '../ai/config';
import { OpenAiCompatibleClient } from '../ai/client';
import { localCallMeta } from '../ai/logger';
import { OpenAiDecisionProvider } from '../ai/provider';
import { seatDiplomacyContext } from '../ai/diplomacy-context';
import { StrategyCoordinator, type TacticianRequestRecord } from '../ai/strategy-coordinator';
import { captureReplayTranscript, type ReplayTranscript } from '../benchmark/replay';
import { budgetedFetch, counting, emptyTally, type Budget, type Tally } from './ai-mode-duel';

const FIXTURE = 'packages/server/fixtures/coverage-oracle.json';
const SEATS: PlayerId[] = ['P1', 'P2', 'P3', 'P4'];

/** What every seat had in force at the first decision of one seat's turn. */
export interface SeatTurnContext {
  decisionIndex: number;
  turn: number;
  seat: PlayerId;
  knobs: Partial<Record<PlayerId, BotSteering>>;
  /** Active deals by seat, as each seat's own diplomacy state shows them. */
  deals: Partial<Record<PlayerId, ReturnType<DiplomacyTable['seatState']>['deals']>>;
  /**
   * Each seat's deal obligations still binding, exactly as its bot enforced them
   * (`DiplomacyTable.playFor(seat).obligations()`), so a study fork can hold the same promises.
   */
  obligations: Partial<Record<PlayerId, ActiveObligation[]>>;
}

export interface StrategistCapture {
  schemaVersion: 1;
  kind: 'strategist-capture';
  createdAt: string;
  offline: boolean;
  diplomacy: boolean;
  /** Whether the strategist's primer offered the tactician request (ADR 0045 decision 5.5). */
  flag: boolean;
  transcript: ReplayTranscript;
  turns: SeatTurnContext[];
  tacticianRequests: TacticianRequestRecord[];
  strategist: { calls: number; capped: boolean; spend: Tally | null };
  timing: { wallClockMs: number; perTurnMs: number; gameTurns: number };
}

export interface CaptureOptions {
  seed: string;
  turnCap: number;
  decks: { commander: OracleCard; cards: OracleCard[] }[];
  config: AiConfig;
  /** The strategist client; null with `offline`. */
  strategist: AiClient | null;
  offline: boolean;
  diplomacy: boolean;
  /** The strategist's tactician request offered in its primer (default) or left out, to compare. */
  flag?: boolean;
  budget?: Budget;
  tally?: Tally;
  maxDecisions?: number;
}

/** A free strategist for `--offline`: balanced knobs every turn, no tactician request. */
export function offlineStrategist(): AiClient {
  return {
    activeModel: 'offline-stub',
    requestDecision(_prompt, request: DecisionRequest) {
      return Promise.resolve({
        response: {
          requestId: request.requestId,
          actionId: 0,
          turnStrategy: {
            intent: 'offline capture',
            plannedActions: [],
            steering: { aggression: 0.5 },
          },
        },
        meta: localCallMeta(),
      });
    },
  };
}

export async function captureStrategistGame(options: CaptureOptions): Promise<StrategistCapture> {
  const started = performance.now();
  const config: AiConfig = {
    ...options.config,
    tacticalMode: 'bot',
    strategistEnabled: true,
    strategistReplan: 'everyTurn',
    strategistTacticianFlag: options.flag === false ? 'off' : 'shadow',
    botEscalation: [],
    botEscalationShadow: [...ESCALATION_TRIGGERS],
  };
  const gameConfig: GameConfig = {
    gameId: `strategist-capture-${options.seed}`,
    seed: options.seed,
    players: options.decks.map((deck, i) => ({
      id: SEATS[i]!,
      deckId: `capture-${i + 1}`,
      commanders: [deck.commander],
      cards: deck.cards,
    })),
    turnCap: options.turnCap,
  };
  const queue = { enqueue: <T>(fn: () => Promise<T>): Promise<T> => fn() };
  const turns: SeatTurnContext[] = [];
  let coordinator: StrategyCoordinator | null = null;
  let table: DiplomacyTable | null = null;
  const providers = new Map<
    PlayerId,
    { decide(request: DecisionRequest): Promise<DecisionResponse> }
  >();
  let engineRef: Engine | null = null;
  const seenTurns = new Set<string>();
  const plannedTurns = new Set<string>();
  let captured = 0;

  const transcript = await captureReplayTranscript(
    gameConfig,
    (seat) => async (request) => {
      const engine = engineRef!;
      const key = `${request.turn}:${request.activePlayer}`;
      // Open the turn's deal window first, as the seat's provider is about to: it expires,
      // releases and negotiates deals, so the strategist's prompt and the obligations noted below
      // are the ones this decision is played under. A second call for the same request is a no-op.
      table?.beforeDecision(request);
      // A live strategist answers in seconds while the bot decides in milliseconds: started on its
      // own, a turn's knobs would land turns later. So the first decision of each turn waits for
      // that turn's strategist answer, and the knobs noted below are the ones the turn played with.
      if (!plannedTurns.has(key)) {
        plannedTurns.add(key);
        coordinator!.prefetch(request.gameId, request.turn, request.activePlayer);
        await coordinator!.drained();
      }
      // The first decision of a seat's own turn: note what every seat had in force.
      if (request.decidingPlayer === request.activePlayer && !seenTurns.has(key)) {
        seenTurns.add(key);
        turns.push({
          // The policy runs for decision N after N decisions were captured: its index is N.
          decisionIndex: captured,
          turn: request.turn,
          seat: request.activePlayer,
          knobs: Object.fromEntries(
            SEATS.flatMap((s) => {
              const knobs = coordinator!.steeringFor(s);
              return knobs === undefined ? [] : [[s, structuredClone(knobs)]];
            }),
          ),
          obligations:
            table === null
              ? {}
              : Object.fromEntries(
                  SEATS.map((s) => [s, structuredClone([...table!.playFor(s).obligations()])]),
                ),
          deals:
            table === null
              ? {}
              : Object.fromEntries(
                  SEATS.map((s) => [s, structuredClone(table!.seatState(s).deals)]),
                ),
        });
      }
      let provider = providers.get(seat);
      if (provider === undefined) {
        const inner = new OpenAiDecisionProvider(
          // Bot-led with no live trigger: the tactician client is never called.
          {
            activeModel: 'none',
            requestDecision: () => Promise.reject(new Error('no tactician in a capture')),
          },
          queue,
          engine,
          config,
          undefined,
          undefined,
          coordinator!,
          undefined,
          undefined,
          table === null ? undefined : (s) => table!.playFor(s),
        );
        provider = table === null ? inner : withDiplomacyAsync(table, inner);
        providers.set(seat, provider);
      }
      return provider.decide(request);
    },
    {
      ...(options.maxDecisions === undefined ? {} : { maxDecisions: options.maxDecisions }),
      onEngine: (engine) => {
        engineRef = engine;
        coordinator = new StrategyCoordinator(
          options.offline ? offlineStrategist() : options.strategist,
          queue,
          engine,
          config,
        );
        if (options.diplomacy) {
          table = new DiplomacyTable({
            seed: options.seed,
            seats: SEATS,
            viewOf: (seat) => engine.view(seat),
            negotiates: () => true,
            // Every seat answers offers at once and proposes with the heuristic proposer; the
            // strategist sees the deals in its prompt.
            repairedAttacks: () =>
              engine.getState().eventLog.filter((e) => e.type === 'attackDeclarationRepaired')
                .length,
          });
          const t = table;
          coordinator.diplomacyFor = (seat, role) => {
            const state = t.seatState(seat);
            return seatDiplomacyContext(
              seat,
              {
                deals: state.deals,
                records: state.trust,
                canPropose: state.canPropose,
                maxRounds: state.maxRounds,
                maxObligationsPerSide: state.maxObligationsPerSide,
              },
              role,
            );
          };
        }
      },
      onDecision: () => {
        captured++;
      },
    },
  );
  // Every call, not only the last: an overtaken call may still be billing or recording.
  await (coordinator as StrategyCoordinator | null)?.drained();
  (table as DiplomacyTable | null)?.flush();
  const wallClockMs = Math.round(performance.now() - started);
  const gameTurns = transcript.decisions.at(-1)?.request.turn ?? 0;
  return {
    schemaVersion: 1,
    kind: 'strategist-capture',
    createdAt: new Date().toISOString(),
    offline: options.offline,
    diplomacy: options.diplomacy,
    flag: options.flag !== false,
    transcript,
    turns,
    tacticianRequests: [...((coordinator as StrategyCoordinator | null)?.tacticianRequests ?? [])],
    strategist: {
      calls: (coordinator as StrategyCoordinator | null)?.strategistStats.calls ?? 0,
      capped: options.budget?.capped ?? false,
      spend: options.tally ?? null,
    },
    timing: {
      wallClockMs,
      perTurnMs: gameTurns === 0 ? 0 : Math.round(wallClockMs / gameTurns),
      gameTurns,
    },
  };
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

/** Four decks named from the coverage fixture. */
export function decksByName(
  file: string,
  cards: readonly OracleCard[],
): { commander: OracleCard; cards: OracleCard[] }[] {
  const byName = new Map(cards.map((card) => [card.name, card]));
  const card = (name: string): OracleCard => {
    const found = byName.get(name);
    if (found === undefined) throw new Error(`--decks: "${name}" is not in ${FIXTURE}`);
    return found;
  };
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { commander: string; cards: string[] }[];
  if (!Array.isArray(raw) || raw.length !== 4) throw new Error('--decks needs exactly four decks');
  return raw.map((deck) => ({ commander: card(deck.commander), cards: deck.cards.map(card) }));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const seed = arg(argv, '--seed') ?? 'strategist-capture';
  const turnCap = Number(arg(argv, '--turn-cap') ?? 40);
  const offline = argv.includes('--offline');
  const diplomacy = !argv.includes('--no-diplomacy');
  const flag = !argv.includes('--no-flag');
  const out = arg(argv, '--out') ?? `benchmark-output/strategist-capture-${seed}.json`;
  const base = loadAiConfig(process.env);
  if (!offline && !base.apiKey) {
    console.error('No AI API key in the environment or .env; use --offline for a free capture.');
    process.exitCode = 1;
    return;
  }
  const fixture = JSON.parse(readFileSync(resolve(FIXTURE), 'utf8')) as OracleCard[];
  const deckFile = arg(argv, '--decks');
  const decks =
    deckFile === undefined
      ? SEATS.map((_, i) =>
          generateCommanderDeck(buildSupportedPool(fixture), { seed: `${seed}-seat${i + 1}` }),
        )
      : decksByName(deckFile, fixture);
  const budget: Budget = {
    maxUsd: Number(arg(argv, '--max-usd') ?? 3),
    maxCalls: Number(arg(argv, '--max-calls') ?? 400),
    spentUsd: 0,
    calls: 0,
    capped: false,
  };
  const tallies = { all: emptyTally() };
  const strategist = offline
    ? null
    : counting(
        new OpenAiCompatibleClient(configForRole(base, 'strategist'), budgetedFetch(budget)),
        'strategist',
        () => 'all' as const,
        tallies,
        budget,
      );
  const capture = await captureStrategistGame({
    seed,
    turnCap,
    decks,
    config: base,
    strategist,
    offline,
    diplomacy,
    flag,
    budget,
    tally: tallies.all,
  });
  writeFileSync(out, JSON.stringify(capture));
  console.log(
    `captured ${capture.transcript.decisions.length} decisions over ${capture.timing.gameTurns} turns in ${capture.timing.wallClockMs} ms ` +
      `(${capture.timing.perTurnMs} ms per turn); strategist calls ${capture.strategist.calls}` +
      `${offline ? ' (offline)' : `, spend $${tallies.all.costUsd.toFixed(4)}${budget.capped ? ' (CAPPED)' : ''}`}; ` +
      `tactician requests ${capture.tacticianRequests.length}; written to ${out}`,
  );
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(import.meta.url)) {
  void main();
}
