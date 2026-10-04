import { Engine, type GameConfig } from '@mtg/engine';
import type { DecisionRequest, DecisionResponse, PlayerId, PlayerView } from '@mtg/shared';

export interface LeaguePolicyTelemetry {
  knownCostUsd?: number;
  costKnown?: boolean;
  usefulStrategyConsumptions?: number;
}

export interface LeaguePolicyRuntime {
  decide(request: DecisionRequest, view: PlayerView): DecisionResponse | Promise<DecisionResponse>;
  telemetry?(): LeaguePolicyTelemetry;
}

export type LeaguePolicyFactory = (input: {
  scenarioId: string;
  seat: PlayerId;
  seed: string;
  role: 'candidate' | 'opponent';
}) => LeaguePolicyRuntime;

export interface LeagueScenario {
  scenarioId: string;
  config: GameConfig;
}

export interface ControlledLeagueOptions {
  scenarios: LeagueScenario[];
  candidateFactory: LeaguePolicyFactory;
  opponentFactory: LeaguePolicyFactory;
  includeAllCandidateTables?: boolean;
  maxTransitions?: number;
}

export interface ControlledLeagueGame {
  scenarioId: string;
  seed: string;
  candidateMode: 'single-seat' | 'all-candidate';
  candidateSeat: PlayerId | null;
  deckRotation: number;
  winnerSeat: PlayerId | null;
  candidateFinish: number | null;
  finishingOrder: PlayerId[];
  eliminationCauses: Record<PlayerId, string | null>;
  halted: boolean;
  haltReason: string | null;
  transitions: number;
  decisions: number;
  knownCostUsd: number;
  costCoverage: number;
  usefulStrategyConsumptions: number;
}

export interface ControlledLeagueReport {
  schemaVersion: 1;
  games: ControlledLeagueGame[];
  singleSeatGames: number;
  allCandidateGames: number;
  haltedGames: number;
  candidateWins: number;
  knownCostUsd: number;
  costCoverage: number;
}

function rotateDecks(config: GameConfig, offset: number): GameConfig {
  const players = config.players.map((player, index, all) => {
    const source = all[(index + offset) % all.length]!;
    return {
      ...structuredClone(source),
      id: player.id,
      deckId: `${source.deckId}:rotation-${offset}:seat-${player.id}`,
    };
  });
  return { ...structuredClone(config), players };
}

async function runGame(
  scenario: LeagueScenario,
  config: GameConfig,
  candidateSeat: PlayerId | null,
  allCandidate: boolean,
  deckRotation: number,
  options: ControlledLeagueOptions,
): Promise<ControlledLeagueGame> {
  const engine = new Engine(config);
  const runtimes = new Map<PlayerId, LeaguePolicyRuntime>();
  for (const player of config.players) {
    const candidate = allCandidate || player.id === candidateSeat;
    runtimes.set(
      player.id,
      (candidate ? options.candidateFactory : options.opponentFactory)({
        scenarioId: scenario.scenarioId,
        seat: player.id,
        seed: config.seed,
        role: candidate ? 'candidate' : 'opponent',
      }),
    );
  }
  const maxTransitions = options.maxTransitions ?? 1_000_000;
  let transitions = 0;
  let decisions = 0;
  let result;
  while (transitions++ < maxTransitions) {
    const step = engine.advance();
    if (step.kind === 'continue') continue;
    if (step.kind === 'gameOver') {
      result = step.result;
      break;
    }
    decisions++;
    const runtime = runtimes.get(step.request.decidingPlayer)!;
    const response = await runtime.decide(step.request, engine.view(step.request.decidingPlayer));
    engine.submit(response);
  }
  const state = engine.getState();
  const telemetry = [...runtimes.values()].map((runtime) => runtime.telemetry?.() ?? {});
  const known = telemetry.filter((item) => item.costKnown === true);
  const finishingOrder = result?.finishingOrder ?? [...state.eliminatedPlayers];
  const candidateFinish =
    candidateSeat === null
      ? null
      : (() => {
          const index = finishingOrder.indexOf(candidateSeat);
          return index < 0 ? null : finishingOrder.length - index;
        })();
  return {
    scenarioId: scenario.scenarioId,
    seed: config.seed,
    candidateMode: allCandidate ? 'all-candidate' : 'single-seat',
    candidateSeat,
    deckRotation,
    winnerSeat: result?.winnerSeat ?? null,
    candidateFinish,
    finishingOrder,
    eliminationCauses: Object.fromEntries(
      state.players.map((player) => [player.id, player.lossReason]),
    ),
    halted: result?.halted ?? true,
    haltReason: result?.haltReason ?? 'transition_limit',
    transitions: Math.min(transitions, maxTransitions),
    decisions,
    knownCostUsd: telemetry.reduce((sum, item) => sum + (item.knownCostUsd ?? 0), 0),
    costCoverage: telemetry.length === 0 ? 0 : known.length / telemetry.length,
    usefulStrategyConsumptions: telemetry.reduce(
      (sum, item) => sum + (item.usefulStrategyConsumptions ?? 0),
      0,
    ),
  };
}

export async function runControlledLeague(
  options: ControlledLeagueOptions,
): Promise<ControlledLeagueReport> {
  const games: ControlledLeagueGame[] = [];
  for (const scenario of options.scenarios) {
    for (let rotation = 0; rotation < scenario.config.players.length; rotation++) {
      const config = rotateDecks(scenario.config, rotation);
      for (const player of config.players) {
        games.push(await runGame(scenario, config, player.id, false, rotation, options));
      }
      if (options.includeAllCandidateTables === true) {
        games.push(await runGame(scenario, config, null, true, rotation, options));
      }
    }
  }
  const knownGames = games.filter((game) => game.costCoverage === 1);
  return {
    schemaVersion: 1,
    games,
    singleSeatGames: games.filter((game) => game.candidateMode === 'single-seat').length,
    allCandidateGames: games.filter((game) => game.candidateMode === 'all-candidate').length,
    haltedGames: games.filter((game) => game.halted).length,
    candidateWins: games.filter(
      (game) => game.candidateMode === 'single-seat' && game.winnerSeat === game.candidateSeat,
    ).length,
    knownCostUsd: games.reduce((sum, game) => sum + game.knownCostUsd, 0),
    costCoverage: games.length === 0 ? 0 : knownGames.length / games.length,
  };
}
