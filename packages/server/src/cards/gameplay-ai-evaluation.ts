/**
 * Gameplay-AI quality evaluation (implementation plan step 15).
 *
 * This is quality evidence, never a rules-correctness gate. It records whether scripted,
 * random, and heuristic providers actually chose to use the reviewed cards in arranged
 * positions where using them is available and advantageous. Live LLM runs are reported as
 * not-run unless an API key is present; they do not substitute for the deterministic merge gate.
 */
import { HeuristicDecisionProvider } from '@mtg/bot';
import { RandomDecisionProvider } from '@mtg/engine';
import type { DecisionResponse, LegalAction, PlayerId } from '@mtg/shared';
import { REVIEWED_BASELINE_SCENARIO_IDS, createCardTestScenario } from './card-test-scenarios';

export type ProviderKind = 'random' | 'heuristic';

export interface DecisionObservation {
  decidingPlayer: string;
  actionType: string;
  description: string;
}

export interface ProviderRun {
  providerKind: ProviderKind;
  seed: string;
  decisions: number;
  casts: number;
  activations: number;
  observations: DecisionObservation[];
  usedSubjectCard: boolean;
}

export interface CardAiEvaluation {
  scenarioId: string;
  card: string;
  subject: string;
  random: ProviderRun;
  heuristic: ProviderRun;
}

export interface GameplayAiReport {
  generatedAt: string;
  liveLlm: 'not-run';
  note: string;
  cards: CardAiEvaluation[];
}

const SUBJECT_BY_SCENARIO: Record<string, { card: string; subject: string }> = {
  'myriad-landscape-viewer-shared-type-search': {
    card: 'Myriad Landscape',
    subject: 'Myriad Landscape',
  },
  'fabled-passage-viewer-search-entry-untap': {
    card: 'Fabled Passage',
    subject: 'Fabled Passage',
  },
  'war-room-viewer-dynamic-life-activation': {
    card: 'War Room',
    subject: 'War Room',
  },
  'smothering-tithe-viewer-pay': {
    card: 'Smothering Tithe',
    subject: 'Lab Pending Spell',
  },
  'arcane-denial-viewer-draw-two': {
    card: 'Arcane Denial',
    subject: 'Arcane Denial',
  },
  'tribute-viewer-cast-search-select-resolve': {
    card: 'Tribute Mage',
    subject: 'Tribute Mage',
  },
  'gev-viewer-opponent-targets-ward': {
    card: 'Gev, Scaled Scorch',
    subject: 'Lab Doom',
  },
  'nightscape-viewer-activate-regenerate-destroy': {
    card: 'Nightscape Familiar',
    subject: 'Nightscape Familiar',
  },
  'thran-viewer-graveyard-departure-trigger': {
    card: 'Thran Vigil',
    subject: 'Grave Picker',
  },
  'harmonic-viewer-cast-and-double-trigger': {
    card: 'Harmonic Prodigy',
    subject: 'Lab Shaman',
  },
};

function usedSubject(observations: DecisionObservation[], subject: string): boolean {
  return observations.some(
    (entry) =>
      entry.decidingPlayer === 'P1' &&
      (entry.actionType === 'castSpell' ||
        entry.actionType === 'activateAbility' ||
        entry.actionType === 'playCard') &&
      entry.description.includes(subject),
  );
}

function runWithProvider(
  scenarioId: string,
  kind: ProviderKind,
  runTag?: string,
  options: { heuristicAllPlayers?: boolean; observeAllPlayers?: boolean } = {},
): ProviderRun {
  const suffix = runTag === undefined ? '' : `-${runTag}`;
  const scenario = createCardTestScenario(scenarioId, `ai-eval-${kind}${suffix}-${scenarioId}`);
  if (scenario === null) throw new Error(`unknown scenario ${scenarioId}`);
  const engine = scenario.engine;
  const seed = `${scenario.seed}-${kind}${suffix}`;
  const random = new RandomDecisionProvider(`${seed}-random`);
  const heuristics = new Map<PlayerId, HeuristicDecisionProvider>();
  const heuristicFor = (playerId: PlayerId) => {
    let provider = heuristics.get(playerId);
    if (provider === undefined) {
      provider = new HeuristicDecisionProvider(`${seed}-heuristic-${playerId}`, () =>
        engine.view(playerId),
      );
      heuristics.set(playerId, provider);
    }
    return provider;
  };
  const observations: DecisionObservation[] = [];
  let decisions = 0;
  for (;;) {
    const step = engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    decisions += 1;
    const request = step.request;
    const response: DecisionResponse =
      kind === 'heuristic' &&
      (request.decidingPlayer === 'P1' || options.heuristicAllPlayers === true)
        ? heuristicFor(request.decidingPlayer).decide(request)
        : random.decide(request);
    const chosen: LegalAction | undefined = request.legalActions.find(
      (action) => action.id === response.actionId,
    );
    if (chosen !== undefined) {
      observations.push({
        decidingPlayer: request.decidingPlayer,
        actionType: chosen.type,
        description: chosen.description,
      });
    }
    engine.submit({
      requestId: request.requestId,
      actionId: response.actionId,
      ...(response.targets !== undefined ? { targets: response.targets } : {}),
    });
    if (decisions > 40) throw new Error(`${scenarioId} (${kind}) did not terminate`);
  }
  const subject = SUBJECT_BY_SCENARIO[scenarioId]!.subject;
  const p1 = observations.filter((entry) => entry.decidingPlayer === 'P1');
  return {
    providerKind: kind,
    seed,
    decisions,
    casts: p1.filter((entry) => entry.actionType === 'castSpell').length,
    activations: p1.filter((entry) => entry.actionType === 'activateAbility').length,
    observations: options.observeAllPlayers === true ? observations : p1,
    usedSubjectCard: usedSubject(p1, subject),
  };
}

export interface ArcaneDenialAiEvaluation {
  evidenceId: 'arcane-denial-ai-counter-and-draw-choice';
  generatedAt: string;
  liveLlm: 'not-run';
  note: string;
  scenarioId: string;
  card: 'Arcane Denial';
  subject: 'Arcane Denial';
  runs: ProviderRun[];
}

/** Separate quality evidence: these observations never certify the card's rules behavior. */
export function evaluateArcaneDenialGameplayAi(): ArcaneDenialAiEvaluation {
  const scenarioId = 'arcane-denial-viewer-draw-two';
  const runs = (['run-1', 'run-2', 'run-3'] as const).flatMap((runTag) =>
    (['random', 'heuristic'] as const).map((kind) =>
      runWithProvider(scenarioId, kind, runTag, {
        heuristicAllPlayers: true,
        observeAllPlayers: true,
      }),
    ),
  );
  return {
    evidenceId: 'arcane-denial-ai-counter-and-draw-choice',
    generatedAt: 'generated-by-evaluateArcaneDenialGameplayAi',
    liveLlm: 'not-run',
    note: 'Quality-only observations from an arranged tactical position. Deterministic engine and viewer evidence independently prove rules behavior; live LLM was not run.',
    scenarioId,
    card: 'Arcane Denial',
    subject: 'Arcane Denial',
    runs,
  };
}

export interface SmotheringTitheAiEvaluation {
  evidenceId: 'smothering-tithe-ai-payment-quality';
  generatedAt: string;
  liveLlm: 'not-run';
  note: string;
  scenarioId: string;
  card: 'Smothering Tithe';
  subject: 'Lab Pending Spell';
  runs: ProviderRun[];
}

/** Quality-only evidence for whether local providers create the draw and answer the tax. */
export function evaluateSmotheringTitheGameplayAi(): SmotheringTitheAiEvaluation {
  const scenarioId = 'smothering-tithe-viewer-pay';
  const runs = (['run-1', 'run-2', 'run-3'] as const).flatMap((runTag) =>
    (['random', 'heuristic'] as const).map((kind) =>
      runWithProvider(scenarioId, kind, runTag, {
        heuristicAllPlayers: true,
        observeAllPlayers: true,
      }),
    ),
  );
  return {
    evidenceId: 'smothering-tithe-ai-payment-quality',
    generatedAt: 'generated-by-evaluateSmotheringTitheGameplayAi',
    liveLlm: 'not-run',
    note: 'Quality-only observations from an arranged opponent-draw and optional-payment position. Deterministic engine and viewer evidence independently prove rules behavior; live LLM was not run.',
    scenarioId,
    card: 'Smothering Tithe',
    subject: 'Lab Pending Spell',
    runs,
  };
}

export interface FabledPassageAiEvaluation {
  evidenceId: 'fabled-passage-ai-search-quality';
  generatedAt: string;
  liveLlm: 'not-run';
  note: string;
  scenarioId: string;
  card: 'Fabled Passage';
  subject: 'Fabled Passage';
  runs: ProviderRun[];
}

export interface MyriadLandscapeAiEvaluation {
  evidenceId: 'myriad-landscape-ai-search-quality';
  generatedAt: string;
  liveLlm: 'not-run';
  note: string;
  scenarioId: string;
  card: 'Myriad Landscape';
  subject: 'Myriad Landscape';
  runs: ProviderRun[];
}

export interface WarRoomAiEvaluation {
  evidenceId: 'war-room-ai-activation-quality';
  generatedAt: string;
  liveLlm: 'not-run';
  note: string;
  scenarioId: string;
  card: 'War Room';
  subject: 'War Room';
  runs: ProviderRun[];
}

/** Quality-only evidence for local-provider activation and grouped-search choices. */
export function evaluateMyriadLandscapeGameplayAi(): MyriadLandscapeAiEvaluation {
  const scenarioId = 'myriad-landscape-viewer-shared-type-search';
  const runs = (['run-1', 'run-2', 'run-3'] as const).flatMap((runTag) =>
    (['random', 'heuristic'] as const).map((kind) =>
      runWithProvider(scenarioId, kind, runTag, {
        heuristicAllPlayers: true,
        observeAllPlayers: true,
      }),
    ),
  );
  return {
    evidenceId: 'myriad-landscape-ai-search-quality',
    generatedAt: 'generated-by-evaluateMyriadLandscapeGameplayAi',
    liveLlm: 'not-run',
    note: 'Quality-only observations from an arranged grouped basic-land search position. Deterministic engine and viewer evidence independently prove rules behavior; live LLM was not run.',
    scenarioId,
    card: 'Myriad Landscape',
    subject: 'Myriad Landscape',
    runs,
  };
}

export function evaluateWarRoomGameplayAi(): WarRoomAiEvaluation {
  const scenarioId = 'war-room-viewer-dynamic-life-activation';
  const runs = (['run-1', 'run-2', 'run-3'] as const).flatMap((runTag) =>
    (['random', 'heuristic'] as const).map((kind) =>
      runWithProvider(scenarioId, kind, runTag, {
        heuristicAllPlayers: true,
        observeAllPlayers: true,
      }),
    ),
  );
  return {
    evidenceId: 'war-room-ai-activation-quality',
    generatedAt: 'generated-by-evaluateWarRoomGameplayAi',
    liveLlm: 'not-run',
    note: 'Quality-only observations from a three-color commander identity activation position. Deterministic engine and viewer evidence independently prove the dynamic life payment; live LLM was not run.',
    scenarioId,
    card: 'War Room',
    subject: 'War Room',
    runs,
  };
}

/** Quality-only evidence for whether local providers activate the arranged land-search line. */
export function evaluateFabledPassageGameplayAi(): FabledPassageAiEvaluation {
  const scenarioId = 'fabled-passage-viewer-search-entry-untap';
  const runs = (['run-1', 'run-2', 'run-3'] as const).flatMap((runTag) =>
    (['random', 'heuristic'] as const).map((kind) =>
      runWithProvider(scenarioId, kind, runTag, {
        heuristicAllPlayers: true,
        observeAllPlayers: true,
      }),
    ),
  );
  return {
    evidenceId: 'fabled-passage-ai-search-quality',
    generatedAt: 'generated-by-evaluateFabledPassageGameplayAi',
    liveLlm: 'not-run',
    note: 'Quality-only observations from an arranged fourth-land search position. Deterministic engine and viewer evidence independently prove rules behavior; live LLM was not run.',
    scenarioId,
    card: 'Fabled Passage',
    subject: 'Fabled Passage',
    runs,
  };
}

export function evaluateReviewedFiveGameplayAi(): GameplayAiReport {
  const cards: CardAiEvaluation[] = REVIEWED_BASELINE_SCENARIO_IDS.map((scenarioId) => {
    const meta = SUBJECT_BY_SCENARIO[scenarioId]!;
    return {
      scenarioId,
      card: meta.card,
      subject: meta.subject,
      random: runWithProvider(scenarioId, 'random'),
      heuristic: runWithProvider(scenarioId, 'heuristic'),
    };
  });
  return {
    generatedAt: 'generated-by-evaluateReviewedFiveGameplayAi',
    liveLlm: 'not-run',
    note: 'Quality observations from arranged lab positions. Scripted engine tests prove rules; these runs record whether random/heuristic providers chose the available advantageous action. Live LLM is not part of the merge gate.',
    cards,
  };
}
