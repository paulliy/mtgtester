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
import type { DecisionResponse, LegalAction } from '@mtg/shared';
import { REVIEWED_FIVE_SCENARIO_IDS, createCardTestScenario } from './card-test-scenarios';

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

function runWithP1Provider(scenarioId: string, kind: ProviderKind): ProviderRun {
  const scenario = createCardTestScenario(scenarioId, `ai-eval-${kind}-${scenarioId}`);
  if (scenario === null) throw new Error(`unknown scenario ${scenarioId}`);
  const engine = scenario.engine;
  const seed = `${scenario.seed}-${kind}`;
  const random = new RandomDecisionProvider(`${seed}-random`);
  const heuristic = new HeuristicDecisionProvider(`${seed}-heuristic`, () => engine.view('P1'));
  const observations: DecisionObservation[] = [];
  let decisions = 0;
  for (;;) {
    const step = engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    decisions += 1;
    const request = step.request;
    const response: DecisionResponse =
      request.decidingPlayer === 'P1' && kind === 'heuristic'
        ? heuristic.decide(request)
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
    observations: p1,
    usedSubjectCard: usedSubject(p1, subject),
  };
}

export function evaluateReviewedFiveGameplayAi(): GameplayAiReport {
  const cards: CardAiEvaluation[] = REVIEWED_FIVE_SCENARIO_IDS.map((scenarioId) => {
    const meta = SUBJECT_BY_SCENARIO[scenarioId]!;
    return {
      scenarioId,
      card: meta.card,
      subject: meta.subject,
      random: runWithP1Provider(scenarioId, 'random'),
      heuristic: runWithP1Provider(scenarioId, 'heuristic'),
    };
  });
  return {
    generatedAt: 'generated-by-evaluateReviewedFiveGameplayAi',
    liveLlm: 'not-run',
    note: 'Quality observations from arranged lab positions. Scripted engine tests prove rules; these runs record whether random/heuristic providers chose the available advantageous action. Live LLM is not part of the merge gate.',
    cards,
  };
}
