/**
 * The hill-climb probes: each measures one cost area and returns its metrics. Nothing here uses
 * the network or a paid model. See docs/guides/hill-climbing.md for what each metric means.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { Engine, type EngineWork } from '@mtg/engine';
import type { AiConfig } from '../ai/config';
import {
  compilerTrials,
  loadRuleEvidence,
  loadScreenHistory,
  loadTrialCards,
  replayScreen,
} from '../cards/compiler-screen';
import { measureCoverage } from '../cards/coverage';
import { PINNED_ORACLE_PATH, type PinnedCard } from '../cards/edhrec-pins';
import type { EdhrecRanking } from '../cards/edhrec-ranking';
import { censusPod } from '../cli/ai-call-census';
import { playGame, sumWork } from '../cli/engine-bench-game';
import type { FuzzDeck } from '../cli/fuzz-game';
import { loadDecks, pod } from '../cli/fuzz-plan';
import { TABLE_ENGINE_LIMITS } from '../match/engine-limits';
import { authoringProbe } from './authoring';
import type { Metric, Report } from './report';
import { measureSettle, poolTextMatches } from '../../../../scripts/card-compiler/settle';

export interface Profile {
  /** Heuristic-only benchmark games played, and their turn cap. */
  engineGames: number;
  engineTurnCap: number;
  /** Game constructions timed per pod. */
  setupReps: number;
  /** Census games per tactical mode, and their turn cap. */
  censusGames: number;
  censusTurnCap: number;
  /** The authoring probe measures the modeled cards among every `authoringStride`-th EDHREC pin. */
  authoringStride: number;
}

export const PROFILES: Record<string, Profile> = {
  quick: {
    engineGames: 3,
    engineTurnCap: 20,
    setupReps: 3,
    censusGames: 2,
    censusTurnCap: 20,
    authoringStride: 8,
  },
  standard: {
    engineGames: 6,
    engineTurnCap: 40,
    setupReps: 10,
    censusGames: 4,
    censusTurnCap: 40,
    authoringStride: 1,
  },
};

export const PROBES = ['engine', 'setup', 'model', 'coverage', 'authoring', 'compiler'] as const;
export type Probe = (typeof PROBES)[number];

type Metrics = Record<string, Metric>;

const RANKING_PATH = 'packages/server/fixtures/edhrec-ranking.json';
const PRIMITIVE_BACKLOG_PATH = 'packages/server/fixtures/primitive-backlog.json';
const DECK_COVERAGE_PATH = 'packages/server/fixtures/deck-coverage.json';

const round = (value: number, digits: number): number => Number(value.toFixed(digits));

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** A timed metric from its repeats: the fastest run, and how far apart the runs were. */
export function timed(samples: number[], unit: string, digits = 2): Metric {
  const fastest = Math.min(...samples);
  const spread = fastest === 0 ? 0 : (Math.max(...samples) - fastest) / fastest;
  return {
    value: round(fastest, digits),
    unit,
    better: 'lower',
    kind: 'timed',
    spread: round(spread, 3),
  };
}

const exact = (value: number, unit: string, better: Metric['better']): Metric => ({
  value,
  unit,
  better,
  kind: 'exact',
});

/** Units for the engine work counters (`engineWork` in @mtg/engine), by counter. */
const WORK_UNITS: Record<keyof EngineWork, string> = {
  layerPasses: 'passes',
  layerCacheHits: 'hits',
  layerDigests: 'digests',
  layerDependencyProbes: 'probes',
  layerValueCounts: 'valueCounts',
  castCheckpoints: 'checkpoints',
  castPreviews: 'previews',
  manaSourceListings: 'listings',
  spellPaymentSearches: 'searches',
  manaPlannerSearches: 'searches',
  manaPlannerStates: 'states',
  stateCopies: 'copies',
  selectorCandidates: 'candidates',
};

/**
 * The engine work counters over the benchmark games, as exact metrics. They count the work the
 * games needed, so they compare only when both sides played the same games (`sameGames`). Cache
 * hits are reported but count neither way: a cheaper design can need fewer lookups.
 */
export function workMetrics(work: EngineWork): Metrics {
  const metrics: Metrics = {};
  for (const kind of Object.keys(WORK_UNITS) as Array<keyof EngineWork>)
    metrics[`engine.work.${kind}`] = {
      ...exact(work[kind], WORK_UNITS[kind], 'lower'),
      sameGames: true,
      ...(kind === 'layerCacheHits' ? { informational: true } : {}),
    };
  return metrics;
}

/** The first `count` seeds whose pod is all heuristic players, as `engine-bench` picks them. */
function heuristicSeeds(decks: FuzzDeck[], count: number): number[] {
  const seeds: number[] = [];
  for (let seed = 0; seeds.length < count; seed++)
    if (pod(decks, seed).providers.every((kind) => kind === 'heuristic')) seeds.push(seed);
  return seeds;
}

/**
 * Engine CPU over the benchmark games, and their fingerprints. Every repeat must reproduce the
 * same fingerprints: a difference means the engine or the bot is not deterministic.
 */
export function engineProbe(
  decks: FuzzDeck[],
  profile: Profile,
  repeats: number,
  log: (line: string) => void,
): { metrics: Metrics; fingerprints: Record<string, string> } {
  const seeds = heuristicSeeds(decks, profile.engineGames);
  const perDecision: number[] = [];
  const medianGame: number[] = [];
  let fingerprints: Record<string, string> = {};
  let work: EngineWork | undefined;
  let snapshotObjects = 0;
  // One untimed game first, so the first timed game is not charged for JIT warm-up.
  playGame(seeds[0]!, pod(decks, seeds[0]!).decks, pod(decks, seeds[0]!).providers, 10);
  for (let repeat = 0; repeat < repeats; repeat++) {
    const runs = seeds.map((seed) => {
      const plan = pod(decks, seed);
      const run = playGame(seed, plan.decks, plan.providers, profile.engineTurnCap);
      if (run.outcome.startsWith('error:')) throw new Error(`seed ${seed}: ${run.outcome}`);
      log(
        `  engine seed ${seed}: ${run.decisions} decisions, ${run.engineMs} ms, ` +
          `${run.work.layerPasses} layer passes, ${run.work.stateCopies} state copies`,
      );
      return run;
    });
    const played = Object.fromEntries(runs.map((run) => [String(run.seed), run.fingerprint]));
    if (repeat > 0 && JSON.stringify(played) !== JSON.stringify(fingerprints))
      throw new Error('the same seeds played differently on a repeat: the games are not seeded');
    fingerprints = played;
    // The counts are exact: a repeat that did different work did not run the same code path.
    const total = sumWork(runs.map((run) => run.work));
    if (work !== undefined && JSON.stringify(total) !== JSON.stringify(work))
      throw new Error(
        'the same games did different engine work on a repeat: a counter is not exact',
      );
    work = total;
    const objects = runs.reduce((sum, run) => sum + run.snapshotObjects, 0);
    if (repeat > 0 && objects !== snapshotObjects)
      throw new Error('the same games retained different playback boards on a repeat');
    snapshotObjects = objects;
    const engineMs = runs.reduce((sum, run) => sum + run.engineMs, 0);
    const decisions = runs.reduce((sum, run) => sum + run.decisions, 0);
    perDecision.push(engineMs / Math.max(1, decisions));
    medianGame.push(median(runs.map((run) => run.engineMs / Math.max(1, run.decisions))));
  }
  return {
    metrics: {
      // The mean is dominated by the slowest game; the median says what a typical game costs.
      'engine.msPerDecision': timed(perDecision, 'ms'),
      'engine.medianGameMsPerDecision': timed(medianGame, 'ms'),
      ...workMetrics(work!),
      // What playback retains: the objects the games' per-line boards hold at the end.
      'engine.snapshotObjects': {
        ...exact(snapshotObjects, 'objects', 'lower'),
        sameGames: true,
      },
    },
    fingerprints,
  };
}

/** Time to construct a four-player game: card interpretation, shuffles and opening hands. */
export function setupProbe(decks: FuzzDeck[], profile: Profile, repeats: number): Metrics {
  const pods = heuristicSeeds(decks, profile.engineGames).map((seed) => pod(decks, seed).decks);
  const start = (seats: FuzzDeck[], rep: number): void => {
    new Engine(
      {
        gameId: 'hill-climb-setup',
        seed: `hill-climb-setup-${rep}`,
        players: seats.map((deck, seat) => ({
          id: `P${seat + 1}`,
          deckId: deck.label,
          commanders: deck.commanders,
          cards: deck.cards,
        })),
      },
      TABLE_ENGINE_LIMITS,
    );
  };
  // One untimed pass, so module loading and JIT warm-up are not counted.
  pods.forEach((seats) => start(seats, 0));
  const samples: number[] = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    const began = performance.now();
    for (let rep = 0; rep < profile.setupReps; rep++) pods.forEach((seats) => start(seats, rep));
    samples.push((performance.now() - began) / (profile.setupReps * pods.length));
  }
  return { 'setup.msPerGame': timed(samples, 'ms') };
}

/** The tactical modes the model probe counts calls under. `default` is what a new game uses. */
const CENSUS_MODES: Array<{ key: string; config: Partial<AiConfig> }> = [
  { key: 'default', config: {} },
  { key: 'model', config: { tacticalMode: 'model' } },
  {
    key: 'bot',
    config: { tacticalMode: 'bot', botEscalation: [], strategistReplan: 'onChange' },
  },
  // Bot mode with the stable-prefix layout (off by default until a paid run backs it), so the
  // layout's cost and cacheability are measured without changing what games send.
  {
    key: 'botCached',
    config: {
      tacticalMode: 'bot',
      botEscalation: [],
      strategistReplan: 'onChange',
      providerPromptCacheLayoutEnabled: true,
    },
  },
  {
    // Hill-climb S6: delta prompts are the default since 2026-11-18, so `bot` measures them; this
    // keeps the full-prompt strategist measured for comparison.
    key: 'botNoDelta',
    config: {
      tacticalMode: 'bot',
      botEscalation: [],
      strategistReplan: 'onChange',
      strategistDeltaEnabled: false,
    },
  },
];

/**
 * Model calls and prompt tokens per turn, counted by the call census: the real provider and
 * strategy coordinator over a stub client, on fixed decks, so nothing is spent and the counts
 * repeat exactly. Seats get their inferred archetype, as in a live match.
 *
 * The cache metrics replay every prompt through `PrefixCacheModel`: the share of prompt text that
 * repeats, in whole blocks, the start of an earlier prompt for the same role in the same game, and
 * the prompt tokens per turn left over once that share is read from a provider's prefix cache.
 * `longPrefixCacheableSharePct` counts a repeated prefix only when it reaches 1,024 tokens, the
 * minimum several provider caches need.
 * They score the prompt layout; what a provider actually caches is measured only by a paid run.
 */
export async function modelProbe(decks: FuzzDeck[], profile: Profile): Promise<Metrics> {
  const metrics: Metrics = {};
  for (const mode of CENSUS_MODES) {
    let turns = 0;
    let calls = 0;
    const roles = {
      tactician: { tokens: 0, chars: 0, cacheable: 0, long: 0 },
      strategist: { tokens: 0, chars: 0, cacheable: 0, long: 0 },
    };
    for (let game = 0; game < profile.censusGames; game++) {
      const counts = await censusPod(
        pod(decks, game).decks,
        `hill-climb-${game}`,
        profile.censusTurnCap,
        mode,
        undefined,
        { archetypes: true },
      );
      turns += counts.turns;
      calls += counts.tactician + counts.strategist;
      roles.tactician.tokens += counts.tacticianPromptTokens;
      roles.tactician.chars += counts.tacticianPromptChars;
      roles.tactician.cacheable += counts.tacticianCacheableChars;
      roles.tactician.long += counts.tacticianLongPrefixChars;
      roles.strategist.tokens += counts.strategistPromptTokens;
      roles.strategist.chars += counts.strategistPromptChars;
      roles.strategist.cacheable += counts.strategistCacheableChars;
      roles.strategist.long += counts.strategistLongPrefixChars;
    }
    const all = Object.values(roles);
    const tokens = all.reduce((sum, role) => sum + role.tokens, 0);
    const chars = all.reduce((sum, role) => sum + role.chars, 0);
    const cacheable = all.reduce((sum, role) => sum + role.cacheable, 0);
    const long = all.reduce((sum, role) => sum + role.long, 0);
    const uncached = all.reduce(
      (sum, role) => sum + (role.chars === 0 ? 0 : role.tokens * (1 - role.cacheable / role.chars)),
      0,
    );
    metrics[`model.${mode.key}.callsPerTurn`] = exact(round(calls / turns, 3), 'calls', 'lower');
    metrics[`model.${mode.key}.promptTokensPerTurn`] = exact(
      Math.round(tokens / turns),
      'tokens',
      'lower',
    );
    metrics[`model.${mode.key}.cacheablePromptSharePct`] = exact(
      chars === 0 ? 0 : round((cacheable / chars) * 100, 2),
      '%',
      'higher',
    );
    metrics[`model.${mode.key}.longPrefixCacheableSharePct`] = exact(
      chars === 0 ? 0 : round((long / chars) * 100, 2),
      '%',
      'higher',
    );
    metrics[`model.${mode.key}.uncachedPromptTokensPerTurn`] = exact(
      Math.round(uncached / turns),
      'tokens',
      'lower',
    );
  }
  return metrics;
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

/** Pinned EDHREC cards that model with no reasons, and the share of all EDHREC slots they fill. */
export function edhrecCoverage(
  pins: readonly PinnedCard[],
  ranking: Pick<EdhrecRanking, 'cards' | 'totalSlots'>,
): { modeled: number; slotSharePct: number } {
  const report = measureCoverage(pins.map((pin) => ({ name: pin.card.name, cards: [pin.card] })));
  const modeled = new Set(
    report.cards.filter((card) => card.modeled && card.reasons.length === 0).map((c) => c.name),
  );
  let slots = 0;
  let count = 0;
  for (const pin of pins) {
    if (!modeled.has(pin.card.name)) continue;
    count++;
    slots += ranking.cards[pin.rank - 1]?.[1] ?? 0;
  }
  return { modeled: count, slotSharePct: round((slots / ranking.totalSlots) * 100, 3) };
}

/** Compiler refusals still waiting on a missing primitive (`bun run primitive-backlog`). */
export function backlogRefusals(backlog: { refusals?: unknown }): number | null {
  return typeof backlog.refusals === 'number' ? backlog.refusals : null;
}

/** Share of the measured real decks that play with every card modeled (`bun run deck-coverage`). */
export function playableDeckPct(report: {
  populations?: Array<{ summary?: { decks?: number; playableExactly?: number } }>;
}): number | null {
  let decks = 0;
  let playable = 0;
  for (const population of report.populations ?? []) {
    decks += population.summary?.decks ?? 0;
    playable += population.summary?.playableExactly ?? 0;
  }
  return decks === 0 ? null : round((playable / decks) * 100, 2);
}

/**
 * The compiler's pre-call screen replayed over every committed trial, leaving each card's own
 * outcome out of the screen that judges it. Catches are refusals declined with no model call;
 * losses are cards that compiled but would have been declined. A rule confirmed by one card alone
 * catches nothing here, so the metric rewards rules that generalize. A refusal whose rule (one in
 * the committed screen history) has since retired, because a modeled card or validated patch now
 * covers the wording, still counts: closing the gap is progress, not a screen regression.
 */
export function compilerScreenMetrics(): Metrics {
  const matches = loadRuleEvidence();
  const history = loadScreenHistory();
  let caught = 0;
  let lost = 0;
  for (const trial of compilerTrials()) {
    const replay = replayScreen(loadTrialCards(trial), matches, { leaveOneOut: true, history });
    caught += replay.caught + replay.settled;
    lost += replay.acceptedLost.length;
  }
  return {
    'coverage.compilerScreenCatches': exact(caught, 'calls', 'higher'),
    'coverage.compilerScreenLosses': exact(lost, 'cards', 'lower'),
  };
}

/**
 * Card coverage, computed live from the pinned Oracle fixtures so an interpreter change shows at
 * once. The backlog and deck metrics are read from their committed reports when those exist.
 */
export function coverageProbe(decks: FuzzDeck[]): Metrics {
  const edhrec = edhrecCoverage(
    readJson<PinnedCard[]>(PINNED_ORACLE_PATH),
    readJson<EdhrecRanking>(RANKING_PATH),
  );
  const fixture = measureCoverage(
    decks.map((deck) => ({ name: deck.label, cards: [...deck.commanders, ...deck.cards] })),
  );
  const metrics: Metrics = {
    'coverage.edhrecModeledCards': exact(edhrec.modeled, 'cards', 'higher'),
    'coverage.edhrecSlotSharePct': exact(edhrec.slotSharePct, '%', 'higher'),
    'coverage.fixtureDeckCardsModeledPct': exact(
      round((fixture.modeledCards / fixture.uniqueCards) * 100, 2),
      '%',
      'higher',
    ),
  };
  Object.assign(metrics, compilerScreenMetrics());
  if (existsSync(PRIMITIVE_BACKLOG_PATH)) {
    const refusals = backlogRefusals(readJson(PRIMITIVE_BACKLOG_PATH));
    if (refusals !== null) metrics['coverage.compilerRefusals'] = exact(refusals, 'cards', 'lower');
  }
  if (existsSync(DECK_COVERAGE_PATH)) {
    const playable = playableDeckPct(readJson(DECK_COVERAGE_PATH));
    if (playable !== null) metrics['coverage.playableDecksPct'] = exact(playable, '%', 'higher');
  }
  return metrics;
}

/**
 * The card compiler's free meaning check (`scripts/card-compiler/render.ts`): how many committed
 * trial patches it settles with no model call, and how many modeled pool cards it renders to
 * their Oracle text (the same check run on the parser's output, a proxy for future patches).
 */
export function compilerProbe(): Metrics {
  return {
    'compiler.textCheckSettledPatches': exact(measureSettle().settled.length, 'patches', 'higher'),
    'compiler.textCheckPoolMatches': exact(poolTextMatches(), 'cards', 'higher'),
  };
}

/**
 * A fixed workload shaped like the engine's (object copies, sorts, JSON), timed as the fastest of
 * seven runs after a warm-up. Timings from two machines are scaled by the ratio of their calibration times.
 */
export function calibrate(): number {
  const once = (): number => {
    const began = performance.now();
    let state = Array.from({ length: 4000 }, (_, i) => ({
      id: i,
      zone: i % 7,
      tags: [i % 3, i % 5],
      counters: { plus: i % 4 },
    }));
    let checksum = 0;
    for (let pass = 0; pass < 300; pass++) {
      state = state.map((item) => ({
        ...item,
        zone: (item.zone + pass) % 7,
        tags: [...item.tags],
      }));
      state.sort((a, b) => a.zone - b.zone || a.id - b.id);
      checksum += JSON.stringify(state.slice(0, 200)).length;
    }
    if (checksum === 0) throw new Error('calibration workload did no work');
    return performance.now() - began;
  };
  once();
  return round(Math.min(...Array.from({ length: 7 }, once)), 2);
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

export interface MeasureOptions {
  profile: string;
  probes: readonly Probe[];
  repeats: number;
  log?: (line: string) => void;
}

/** Runs the chosen probes and returns the report. Reads fixtures relative to the repository root. */
export async function measure(options: MeasureOptions): Promise<Report> {
  const profile = PROFILES[options.profile];
  if (profile === undefined) throw new Error(`unknown profile ${options.profile}`);
  const log = options.log ?? (() => {});
  const decks = await loadDecks();
  const metrics: Metrics = {};
  let fingerprints: Record<string, string> = {};
  const calibrationMs = calibrate();
  for (const probe of options.probes) {
    log(`${probe}…`);
    if (probe === 'engine') {
      const engine = engineProbe(decks, profile, options.repeats, log);
      Object.assign(metrics, engine.metrics);
      fingerprints = engine.fingerprints;
    } else if (probe === 'setup')
      Object.assign(metrics, setupProbe(decks, profile, options.repeats));
    else if (probe === 'model') Object.assign(metrics, await modelProbe(decks, profile));
    else if (probe === 'authoring')
      Object.assign(metrics, authoringProbe(profile.authoringStride, log).metrics);
    else if (probe === 'compiler') Object.assign(metrics, compilerProbe());
    else Object.assign(metrics, coverageProbe(decks));
  }
  // The machine's speed drifts over a long run, so calibrate again and keep the faster reading.
  const calibration = Math.min(calibrationMs, calibrate());
  const cpu = cpus();
  return {
    schema: 1,
    profile: options.profile,
    probes: [...options.probes],
    commit: git(['rev-parse', '--short', 'HEAD']).trim() || 'unknown',
    dirty: git(['status', '--porcelain']).trim() !== '',
    machine: `${cpu[0]?.model ?? 'unknown cpu'} x${cpu.length}, ${process.platform}-${process.arch}, bun ${process.versions['bun'] ?? 'none'}`,
    calibrationMs: calibration,
    repeats: options.repeats,
    metrics,
    fingerprints,
  };
}
