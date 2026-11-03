import { format, resolveConfig } from 'prettier';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { DecisionRequest, DecisionResponse, GameId } from '../packages/shared/src';
import { canonicalEngineStateHash } from '../packages/server/src/benchmark/replay';
import { sha256 } from '../packages/server/src/benchmark/hash';
import { createCardTestScenario } from '../packages/server/src/cards/card-test-scenarios';
import { evaluateMyriadLandscapeGameplayAi } from '../packages/server/src/cards/gameplay-ai-evaluation';
import {
  loadGeneratorViewerEvidence,
  validateCurrentEvidenceSources,
  type ValidatedViewerEvidence,
} from './card-evidence-input';

const ORACLE_ID = '2549bc57-9ffb-4053-9f10-f2a5f792b845';
const ORACLE_SHA256 = '696f038611a9d1540a151ab63ccc13e36fd4aa355a54806e741eb6a44f77442b';

const SOURCE_FILES = [
  'packages/engine/src/cards/overrides/coverage-pr10.ts',
  'packages/engine/src/stack/retarget.ts',
  'packages/engine/src/cards/overrides/coverage-pr09.ts',
  'packages/engine/src/cards/overrides/coverage-pr11.ts',
  'packages/engine/src/cards/overrides/coverage-pr11b.ts',
  'packages/engine/src/cards/overrides/coverage-pr12.ts',
  'packages/engine/src/effects/library-cast.ts',
  'packages/engine/src/effects/library-reveal.ts',
  'packages/engine/src/state/copy-data.ts',
  'packages/engine/src/view/library-top.ts',
  'packages/engine/tests/fixtures/coverage-pr09-oracle.json',
  'packages/engine/tests/fixtures/coverage-pr10-oracle.json',
  'packages/engine/tests/fixtures/coverage-pr11-oracle.json',
  'packages/engine/tests/fixtures/coverage-pr12-oracle.json',
  'packages/engine/tests/fixtures/coverage-pr13-oracle.json',
  'packages/server/src/cards/pr09-choice-scenarios.ts',
  'packages/server/src/cards/pr09-library-scenarios.ts',
  'packages/server/src/cards/pr09-permanent-scenarios.ts',
  'packages/server/src/cards/pr09-scenario-catalog.ts',
  'packages/server/src/cards/pr09-scenario-fixtures.ts',
  'packages/server/src/cards/pr09-scenarios.ts',
  'packages/server/src/cards/pr10-scenarios.ts',
  'packages/server/src/cards/pr11-scenarios.ts',
  'packages/server/src/cards/pr11b-scenarios.ts',
  'packages/server/src/cards/pilot-current-scenarios.ts',
  'packages/server/src/cards/pr12-scenarios.ts',
  'packages/server/src/cards/pr13-scenarios.ts',
  'packages/server/src/cards/runner-scenarios.ts',
  'packages/engine/src/effects/owner-library-choices.ts',
  'packages/server/src/cards/pr08-boseiju-scenarios.ts',
  'packages/server/src/cards/pr08-modal-player-scenarios.ts',
  'packages/server/src/cards/pr08-olorin-scenarios.ts',
  'packages/server/src/cards/pr08-remaining-scenarios.ts',
  'packages/server/src/cards/pr08-rotating-survivor-scenarios.ts',
  'packages/server/src/cards/pr08-winds-of-abandon-scenarios.ts',
  'packages/server/src/cards/pr08-cut-a-deal-scenarios.ts',
  'packages/server/src/cards/pr08-scenario-catalog.ts',
  'packages/engine/tests/fixtures/coverage-pr08-oracle.json',
  'packages/engine/src/cards/overrides/coverage-pr08.ts',
  'packages/server/src/cards/white-black-control-keyword-scenarios.ts',
  'apps/web/e2e/white-black-control-keywords.spec.ts',
  'packages/server/src/cards/white-black-control-keyword-scenarios.test.ts',
  'packages/engine/src/stack/replicate-targets.ts',
  'packages/server/src/cards/pr02-follow-up-scenarios.ts',
  'apps/web/e2e/pr02-limited-mechanics.spec.ts',
  'packages/engine/tests/fixtures/transformed-dfc-copy-oracle.json',
  'packages/server/src/cards/transformed-dfc-scenarios.ts',
  'packages/engine/src/cards/authoring-validation.ts',
  'packages/engine/src/cards/overrides/white-black-control-bandit.ts',
  'packages/engine/src/cards/expression-validation.ts',
  'packages/engine/src/cards/effect-reference-contracts.ts',
  'packages/engine/src/utils/assert-never.ts',
  'packages/engine/src/targets/context.ts',
  'packages/engine/src/targets/legality.ts',
  'packages/engine/src/targets/per-player.ts',
  'packages/engine/src/targets/resolution.ts',
  'packages/engine/src/targets/announcement.ts',
  'packages/engine/tests/fixtures/bug-hunt-oracle.json',
  'packages/engine/tests/fixtures/hideaway-casting-oracle.json',
  'packages/server/fixtures/coverage-oracle.json',
  'packages/server/src/cards/bug-hunt-scenarios.ts',
  'scripts/card-evidence-input.ts',
  'apps/web/src/views/CardTestLabView.vue',
  'docs/plans/fail-closed-card-restoration.md',
  'packages/engine/src/cards/overrides/necron-dynasties.ts',
  'packages/engine/src/cards/overrides/necron-dynasties-remaining.ts',
  'packages/engine/src/effects/resolve.ts',
  'packages/engine/src/index.ts',
  'packages/engine/src/testing/candidate-definition.ts',
  'packages/engine/tests/fail-closed-restoration.test.ts',
  'packages/engine/tests/myriad-landscape.test.ts',
  'packages/server/src/cards/card-test-scenarios.ts',
  'packages/server/src/cards/white-black-control-combat-scenarios.ts',
  'packages/server/src/cards/white-black-control-hand-scenarios.ts',
  'packages/server/src/cards/white-black-control-entry-scenarios.ts',
  'packages/server/src/cards/white-black-control-discard-extension-scenarios.ts',
  'packages/engine/tests/fixtures/white-black-control-oracle.json',
  'packages/engine/tests/white-black-control-tergrid.test.ts',
  'packages/engine/src/cards/overrides/white-black-control-tergrid.ts',
  'packages/engine/src/cards/overrides/white-black-control-aven.ts',
  'packages/engine/src/cards/overrides/white-black-control-gifts.ts',
  'packages/server/src/cards/white-black-control-counter-class-scenarios.ts',
  'packages/engine/src/cards/overrides/white-black-control-discard-choices.ts',
  'packages/engine/src/cards/overrides/white-black-control-defenders.ts',
  'packages/engine/src/cards/overrides/white-black-control-curse.ts',
  'packages/engine/src/cards/overrides/white-black-control-promise.ts',
  'packages/engine/src/stack/target-occurrences.ts',
  'packages/server/src/cards/white-black-control-defender-scenarios.ts',
  'packages/engine/src/cards/overrides/white-black-control-discard.ts',
  'packages/engine/src/cards/overrides/white-black-control-entry.ts',
  'packages/engine/src/cards/overrides/white-black-control-graveyard-triggers.ts',
  'packages/engine/src/cards/overrides/white-black-control-graveyard.ts',
  'packages/engine/src/cards/overrides/white-black-control-hand.ts',
  'packages/engine/src/cards/overrides/white-black-control-leyline.ts',
  'packages/engine/src/cards/overrides/white-black-control-library.ts',
  'packages/engine/src/cards/overrides/white-black-control-liliana.ts',
  'packages/engine/src/cards/overrides/white-black-control-payoffs.ts',
  'packages/engine/src/cards/overrides/white-black-control-protection-stack.ts',
  'packages/engine/src/cards/overrides/white-black-control-stax.ts',
  'packages/engine/src/cards/overrides/white-black-control-tinybones.ts',
  'packages/server/src/cards/card-test-scenarios.test.ts',
  'packages/server/src/cards/gameplay-ai-evaluation.ts',
  'packages/server/src/cards/gameplay-ai-evaluation.test.ts',
  'packages/server/src/match/runner.ts',
  'packages/server/src/match/session.ts',
  'packages/server/fixtures/card-verification-manifest.json',
  'apps/web/e2e/card-test-lab.spec.ts',
  'scripts/generate-myriad-landscape-evidence.ts',
  'apps/web/src/views/PlayerGameView.vue',
  'apps/web/src/views/GameView.vue',
  'apps/web/src/components/SeatPanel.vue',
  'apps/web/src/components/PermanentChip.vue',
  'apps/web/src/lib/stackPermanents.ts',
  'apps/web/src/lib/protocol.ts',
  'apps/web/src/components/ActionLog.vue',
  'apps/web/src/stores/game.ts',
  '.prettierrc',
  'packages/bot/package.json',
  'packages/bot/src/combat-search.ts',
  'packages/bot/src/combat-snapshot.ts',
  'packages/bot/src/diplomacy/compliance.ts',
  'packages/bot/src/diplomacy/estimate.ts',
  'packages/bot/src/diplomacy/exploiter.ts',
  'packages/bot/src/diplomacy/index.ts',
  'packages/bot/src/diplomacy/play.ts',
  'packages/bot/src/diplomacy/propose.ts',
  'packages/bot/src/diplomacy/render.ts',
  'packages/bot/src/diplomacy/table.ts',
  'packages/bot/src/diplomacy/trust.ts',
  'packages/bot/src/diplomacy/value.ts',
  'packages/bot/src/evaluate.ts',
  'packages/bot/src/index.ts',
  'packages/bot/src/provider.ts',
  'packages/bot/src/rng.ts',
  'packages/bot/src/veto.ts',
  'packages/bot/src/weights.ts',
  'packages/engine/package.json',
  'packages/engine/src/actions/ability-modes.ts',
  'packages/engine/src/actions/apply.ts',
  'packages/engine/src/casting/cast.ts',
  'packages/engine/src/casting/free.ts',
  'packages/engine/src/casting/checkpoint.ts',
  'packages/engine/src/casting/preview.ts',
  'packages/engine/src/actions/legal.ts',
  'packages/engine/src/cards/ability.ts',
  'packages/engine/src/cards/condition.ts',
  'packages/engine/src/cards/creature-types.ts',
  'packages/engine/src/cards/definition.ts',
  'packages/engine/src/cards/grammar/amount.ts',
  'packages/engine/src/cards/grammar/condition.ts',
  'packages/engine/src/cards/grammar/copy.ts',
  'packages/engine/src/cards/grammar/cost.ts',
  'packages/engine/src/cards/grammar/diagnostics.ts',
  'packages/engine/src/cards/grammar/effect.ts',
  'packages/engine/src/cards/grammar/subject.ts',
  'packages/engine/src/cards/grammar/trigger-event.ts',
  'packages/engine/src/cards/grammar/words.ts',
  'packages/engine/src/cards/interpret.ts',
  'packages/engine/src/cards/overrides/counter-intelligence.ts',
  'packages/engine/src/cards/overrides/coverage-pr01.ts',
  'packages/engine/src/cards/overrides/coverage-pr02.ts',
  'packages/engine/src/cards/overrides/coverage-pr03.ts',
  'packages/engine/src/cards/overrides/coverage-pr06.ts',
  'packages/engine/src/cards/overrides/coverage-pr07.ts',
  'packages/engine/src/cards/overrides/draconic-destruction.ts',
  'packages/engine/src/cards/overrides/index.ts',
  'packages/engine/src/cards/overrides/living-energy.ts',
  'packages/engine/src/cards/overrides/marchesa-the-black-rose.ts',
  'packages/engine/src/cards/overrides/mini-pilot.ts',
  'packages/engine/src/cards/overrides/pilot-new.ts',
  'packages/engine/src/cards/overrides/pilot-current.ts',
  'packages/engine/src/cards/overrides/queen-marchesa-queens-gambit-remaining.ts',
  'packages/engine/src/cards/overrides/queen-marchesa-queens-gambit.ts',
  'packages/engine/src/cards/overrides/reviewed-five.ts',
  'packages/engine/src/cards/overrides/silverquill-influence-remaining.ts',
  'packages/engine/src/cards/overrides/silverquill-influence.ts',
  'packages/engine/src/cards/overrides/token-triumph.ts',
  'packages/engine/src/cards/overrides/urdragon.ts',
  'packages/engine/src/cards/overrides/w1-remaining.ts',
  'packages/engine/src/cards/overrides/w2-remaining.ts',
  'packages/engine/src/cards/selector.ts',
  'packages/engine/src/cards/source-identity.ts',
  'packages/engine/src/cards/templates.ts',
  'packages/engine/src/cards/tokens.ts',
  'packages/engine/src/cards/value.ts',
  'packages/engine/src/combat/combat.ts',
  'packages/engine/src/decisions.ts',
  'packages/engine/src/effects/choose.ts',
  'packages/engine/src/effects/continuous.ts',
  'packages/engine/src/effects/damage-modifiers.ts',
  'packages/engine/src/effects/layer-cache.ts',
  'packages/engine/src/effects/values.ts',
  'packages/engine/src/engine.ts',
  'packages/engine/src/errors.ts',
  'packages/engine/src/exits.ts',
  'packages/engine/src/flow/game.ts',
  'packages/engine/src/log/log.ts',
  'packages/engine/src/mana/activation.ts',
  'packages/engine/src/mana/spell-payment.ts',
  'packages/engine/src/mana/cost.ts',
  'packages/engine/src/mana/pool.ts',
  'packages/engine/src/mana/manual.ts',
  'packages/engine/src/present.ts',
  'packages/engine/src/providers/providers.ts',
  'packages/engine/src/rng/chacha20.ts',
  'packages/engine/src/rng/engine-rng.ts',
  'packages/engine/src/rng/prng.ts',
  'packages/engine/src/sba/sba.ts',
  'packages/engine/src/signals.ts',
  'packages/engine/src/stack/stack.ts',
  'packages/engine/src/state/game.ts',
  'packages/engine/src/state/objects.ts',
  'packages/engine/src/state/off-battlefield-types.ts',
  'packages/engine/src/state/queries.ts',
  'packages/engine/src/testing/card-scenario.ts',
  'packages/engine/src/testing/checkpoint-hook.ts',
  'packages/engine/src/testing/definition-transform.ts',
  'packages/engine/src/testing/diagnostics.ts',
  'packages/engine/src/testing/prepared-scenario.ts',
  'packages/engine/src/turn/mulligan.ts',
  'packages/engine/src/turn/priority.ts',
  'packages/engine/src/turn/stops.ts',
  'packages/engine/src/turn/turn.ts',
  'packages/engine/src/view/spectator.ts',
  'packages/engine/src/view/view.ts',
  'packages/engine/tests/fixtures/draconic-engine-batch1-oracle.json',
  'packages/engine/tests/fixtures/draconic-engine-batch2-oracle.json',
  'packages/engine/tests/fixtures/draconic-engine-batch3-oracle.json',
  'packages/engine/tests/fixtures/living-energy-engine-batch1-oracle.json',
  'packages/engine/tests/fixtures/living-energy-engine-batch2-oracle.json',
  'packages/engine/tests/fixtures/living-energy-engine-batch5-oracle.json',
  'packages/engine/tests/fixtures/coverage-pr01-oracle.json',
  'packages/engine/tests/fixtures/coverage-pr02-oracle.json',
  'packages/engine/tests/fixtures/coverage-pr03-oracle.json',
  'packages/engine/tests/fixtures/coverage-pr04-oracle.json',
  'packages/engine/tests/fixtures/coverage-pr05-oracle.json',
  'packages/engine/tests/fixtures/coverage-pr06-oracle.json',
  'packages/engine/tests/fixtures/coverage-pr07-oracle.json',
  'packages/engine/tests/fixtures/marchesa-batch1-oracle.json',
  'packages/engine/tests/fixtures/necron-main-engine-batch1-oracle.json',
  'packages/engine/tests/fixtures/necron-main-engine-batch2-oracle.json',
  'packages/engine/tests/fixtures/necron-remaining-engine-batch1-oracle.json',
  'packages/engine/tests/fixtures/queen-engine-batch1-oracle.json',
  'packages/engine/tests/fixtures/queen-engine-batch2-oracle.json',
  'packages/engine/tests/fixtures/queen-engine-batch3-oracle.json',
  'packages/engine/tests/fixtures/pin-store.json',
  'packages/engine/tests/fixtures/reviewed-five-oracle.json',
  'packages/engine/tests/scenarios/academy-manufactor.json',
  'packages/engine/tests/scenarios/chrome-mox.json',
  'packages/engine/tests/scenarios/electrickery.json',
  'packages/engine/tests/scenarios/ettercap.json',
  'packages/engine/tests/scenarios/everflowing-chalice.json',
  'packages/engine/tests/scenarios/inspiring-call.json',
  'packages/engine/tests/scenarios/mithril-coat.json',
  'packages/engine/tests/scenarios/mizzium-mortars.json',
  'packages/engine/tests/scenarios/mox-diamond.json',
  'packages/engine/tests/scenarios/orcish-bowmasters.json',
  'packages/engine/tests/scenarios/path-to-exile.json',
  'packages/engine/tests/scenarios/phyrexian-metamorph.json',
  'packages/engine/tests/scenarios/professional-face-breaker.json',
  'packages/engine/tests/scenarios/ragavan-nimble-pilferer.json',
  'packages/engine/tests/scenarios/sylvan-library.json',
  'packages/engine/tests/scenarios/takenuma-abandoned-mire.json',
  'packages/engine/tests/scenarios/the-ozolith.json',
  'packages/engine/tests/scenarios/witch-enchanter.json',
  'packages/engine/tests/fixtures/silverquill-main-engine-batch1-oracle.json',
  'packages/engine/tests/fixtures/silverquill-remaining-engine-batch1-oracle.json',
  'packages/engine/tests/fixtures/token-triumph-engine-batch1-oracle.json',
  'packages/engine/tests/fixtures/token-triumph-engine-batch2-oracle.json',
  'packages/engine/tests/fixtures/token-triumph-engine-batch3-oracle.json',
  'packages/engine/tests/fixtures/w2-remaining-engine-batch1-oracle.json',
  'packages/server/src/ai/plan-lifecycle.ts',
  'packages/server/src/ai/turn-plan.ts',
  'packages/server/src/ai/versions.ts',
  'packages/server/src/benchmark/hash.ts',
  'packages/server/src/benchmark/replay.ts',
  'packages/shared/package.json',
  'packages/shared/src/action-data-keys.ts',
  'packages/shared/src/assert-never.ts',
  'packages/shared/src/batch.ts',
  'packages/shared/src/cards.ts',
  'packages/shared/src/decks.ts',
  'packages/shared/src/diplomacy.ts',
  'packages/shared/src/engine.ts',
  'packages/shared/src/enums.ts',
  'packages/shared/src/index.ts',
  'packages/shared/src/json.ts',
  'packages/shared/src/mana.ts',
  'packages/shared/src/objects.ts',
  'packages/shared/src/protocol.ts',
  'packages/shared/src/table-protocol.ts',
  'packages/shared/src/turn-labels.ts',
  'packages/engine/src/cards/ir-graph.ts',
  'packages/engine/src/cards/mana-riders.ts',
  'packages/engine/src/cards/overload.ts',
  'packages/engine/src/casting/permissions.ts',
  'packages/engine/src/mana/stateful-payment.ts',
  'packages/engine/src/mana/tap-preference.ts',
  'packages/engine/src/cards/capabilities.ts',
  'packages/engine/src/cards/spell-faces.ts',
  'packages/engine/src/stack/copy.ts',
  'packages/engine/src/state/phasing.ts',
  'packages/engine/tests/fixtures/target-untap-oracle.json',
  'packages/server/src/cards/target-untap-scenarios.ts',
  'packages/engine/src/cards/cost-contracts.ts',
  'packages/engine/src/cards/target-builders.ts',
  'packages/engine/src/cards/trigger-contracts.ts',
  'packages/engine/src/cards/scope-contracts.ts',
  'packages/engine/src/state/counters.ts',
  'packages/engine/src/cards/effect-builders.ts',
  'packages/engine/tests/fixtures/selected-spell-faces-oracle.json',
  'packages/server/src/cards/spell-face-lab-expectations.ts',
  'packages/server/src/cards/spell-face-scenarios.ts',
  'packages/engine/tests/fixtures/counter-targets-oracle.json',
  'packages/engine/tests/fixtures/overload-derivation-oracle.json',
  'packages/server/src/cards/counter-overload-scenarios.ts',
  'packages/engine/tests/fixtures/zone-change-trigger-oracle.json',
  'packages/server/src/cards/zone-change-trigger-scenarios.ts',
  'packages/engine/tests/fixtures/specialized-reference-oracle.json',
  'packages/server/src/cards/specialized-reference-scenarios.ts',
  'packages/engine/src/cards/mana-production.ts',
  'packages/engine/tests/fixtures/overload-static-review-oracle.json',
  'packages/server/src/cards/combat-trigger-scenarios.ts',
  'packages/server/src/cards/drakuseth-wording-scenarios.ts',
  'packages/engine/tests/fixtures/drakuseth-wording-oracle.json',
  'packages/server/src/cards/combat-trigger-scenarios.test.ts',
  'packages/engine/tests/fixtures/combat-trigger-oracle.json',
  'apps/web/e2e/combat-trigger-regressions.spec.ts',
  'packages/engine/src/cards/overrides/white-black-control-imp.ts',
  'packages/engine/src/cards/overrides/white-black-control-restoration.ts',
  'packages/engine/src/cards/overrides/white-black-control-role-model.ts',
  'packages/engine/src/cards/overrides/white-black-control-cloak.ts',
  'packages/server/src/cards/white-black-control-spell-scenarios.ts',
  'packages/engine/src/state/types.ts',
  'packages/engine/tests/arcane-denial.test.ts',
  'packages/engine/tests/delayed-triggers.test.ts',
  'packages/engine/tests/fabled-passage.test.ts',
  'packages/engine/tests/library.test.ts',
  'packages/engine/tests/smothering-tithe.test.ts',
  'packages/engine/tests/war-room.test.ts',
  'packages/server/src/cards/war-room-evidence.test.ts',
  'packages/server/src/match/session.test.ts',
  'packages/server/src/ws/server.ts',
  'scripts/generate-arcane-denial-evidence.ts',
  'scripts/generate-fabled-passage-evidence.ts',
  'scripts/generate-smothering-tithe-evidence.ts',
  'scripts/generate-war-room-evidence.ts',
  'packages/engine/src/cards/overrides/white-black-control-perch.ts',
  'packages/server/src/cards/white-black-control-final-scenarios.ts',
  'packages/engine/tests/phasing-elimination-contract.test.ts',
  'packages/server/src/cards/white-black-control-perch-scenarios.ts',
  'packages/server/src/cards/white-black-control-protection-scenarios.ts',
  'packages/server/src/cards/white-black-control-discard-core-scenarios.ts',
  'packages/server/src/cards/white-black-control-graveyard-scenarios.ts',
  'packages/server/src/cards/white-black-control-stax-scenarios.ts',
  'packages/server/src/cards/white-black-control-replacements-scenarios.ts',
  'packages/server/src/cards/white-black-control-liliana-scenarios.ts',
  'packages/server/src/cards/white-black-control-remaining-combat-scenarios.ts',
  'packages/server/src/cards/white-black-control-tergrid-scenarios.ts',
  'packages/server/src/cards/white-black-control-hand-limit-scenarios.ts',
] as const;

const TRACE_PATHS = {
  'myriad-landscape-viewer-enters-tapped':
    'test-results/card-test-lab-Myriad-Lands-bbca7-mal-land-play-enters-tapped/trace.zip',
  'myriad-landscape-viewer-colorless-mana':
    'test-results/card-test-lab-Myriad-Lands-72cee-less-mana-pays-a-spell-cost/trace.zip',
  'myriad-landscape-viewer-shared-type-search':
    'test-results/card-test-lab-Myriad-Lands-c692e-enforces-a-shared-land-type/trace.zip',
} as const;

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function workspaceRevision(viewer?: ValidatedViewerEvidence) {
  const files = Object.fromEntries(SOURCE_FILES.map((path) => [path, fileSha256(path)]));
  return {
    gitHead: execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).trim(),
    ...(viewer && { testedTree: viewer.testedTree, reportSha256: viewer.reportSha256 }),
    sourceSha256: sha256(files),
    files,
  };
}

function choose(request: DecisionRequest): DecisionResponse {
  const action = request.legalActions.find(
    (candidate) =>
      candidate.description.includes('Play Myriad Landscape') ||
      candidate.description.includes('Cast Myriad Mana Sink') ||
      (candidate.description.includes('Island') &&
        candidate.description.includes('Myriad Shared Dual')),
  );
  if (action !== undefined) return { requestId: request.requestId, actionId: action.id };
  const activate = request.legalActions.find((candidate) =>
    candidate.description.includes('Search for up to two basic lands'),
  );
  if (activate !== undefined) return { requestId: request.requestId, actionId: activate.id };
  const pass = request.legalActions.find((candidate) => candidate.type === 'pass');
  const fallback = pass ?? request.legalActions[0];
  if (fallback === undefined) throw new Error('Myriad Landscape evidence request had no action');
  return { requestId: request.requestId, actionId: fallback.id };
}

function driveScenario(id: keyof typeof TRACE_PATHS) {
  const scenario = createCardTestScenario(id, `evidence-${id}` as GameId);
  if (scenario === null) throw new Error(`missing Card Test Lab scenario ${id}`);
  const scenarioSha256 = sha256({
    metadata: scenario.metadata,
    seed: scenario.seed,
    initialState: scenario.engine.getState(),
  });
  let decisions = 0;
  for (;;) {
    const step = scenario.engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    scenario.engine.submit(choose(step.request));
    if (++decisions > 40) throw new Error(`${id} exceeded its decision budget`);
  }
  return { scenario, scenarioSha256, decisions };
}

function assertEvidence(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Myriad Landscape evidence failed: ${message}`);
}

function runScenario(id: keyof typeof TRACE_PATHS, viewer?: ValidatedViewerEvidence) {
  const first = driveScenario(id);
  const replay = driveScenario(id);
  const { scenario, scenarioSha256, decisions } = first;
  const state = scenario.engine.getState();
  const p1 = state.players.find((player) => player.id === 'P1')!;
  const p2View = JSON.stringify(scenario.engine.view('P2'));
  const finalStateSha256 = canonicalEngineStateHash(scenario.engine);
  const replayFinalStateSha256 = canonicalEngineStateHash(replay.scenario.engine);
  const eventLogSha256 = sha256(state.eventLog);
  const replayEventLogSha256 = sha256(replay.scenario.engine.getState().eventLog);
  const tracePath = viewer === undefined ? TRACE_PATHS[id] : viewer.traces[id]!.path;
  const landscape = state.battlefield.find(
    (permanent) => permanent.controllerId === 'P1' && permanent.name === 'Myriad Landscape',
  );
  const found = state.battlefield.filter(
    (permanent) =>
      permanent.controllerId === 'P1' && ['Island', 'Myriad Shared Dual'].includes(permanent.name),
  );

  assertEvidence(scenario.metadata.oracleSha256 === ORACLE_SHA256, `${id} Oracle hash drifted`);
  if (id === 'myriad-landscape-viewer-enters-tapped') {
    assertEvidence(landscape?.tapped === true, 'normal land play did not enter tapped');
  } else if (id === 'myriad-landscape-viewer-colorless-mana') {
    assertEvidence(landscape?.tapped === true, 'colorless mana ability did not tap Landscape');
    assertEvidence(
      state.battlefield.some((permanent) => permanent.name === 'Myriad Mana Sink'),
      'sink did not resolve',
    );
  } else {
    assertEvidence(
      p1.graveyard.some((card) => card.name === 'Myriad Landscape'),
      'sacrifice cost was not paid',
    );
    assertEvidence(
      found.length === 2 && found.every((permanent) => permanent.tapped),
      'shared pair did not enter tapped',
    );
    assertEvidence(
      !p2View.includes('Myriad Private Library Secret'),
      'private library card leaked',
    );
  }
  assertEvidence(
    state.eventLog.some(
      (event) =>
        event.type === 'playLand' || event.type === 'castSpell' || event.type === 'activateAbility',
    ),
    `${id} did not use a normal engine path`,
  );
  assertEvidence(existsSync(tracePath), `${id} retained Playwright trace is missing`);
  assertEvidence(
    finalStateSha256 === replayFinalStateSha256 && eventLogSha256 === replayEventLogSha256,
    `${id} was not deterministic under replayed decisions`,
  );
  return {
    id,
    seed: scenario.seed,
    oracleSha256: scenario.metadata.oracleSha256,
    clauseIds: scenario.metadata.clauseIds,
    scenarioSha256,
    finalStateSha256,
    replayFinalStateSha256,
    eventLogSha256,
    replayEventLogSha256,
    decisions,
    observations: {
      landscapeTapped: landscape?.tapped ?? null,
      foundNames: found.map((permanent) => permanent.name),
      p1Graveyard: p1.graveyard.map((card) => card.name),
      p2ViewLeaksPrivateName: p2View.includes('Myriad Private Library Secret'),
    },
    viewerTrace: { path: tracePath, sha256: fileSha256(tracePath) },
  };
}

export function generateMyriadLandscapeVerificationEvidence(viewer?: ValidatedViewerEvidence) {
  if (viewer !== undefined) validateCurrentEvidenceSources(viewer, process.cwd());
  return {
    schemaVersion: 1,
    generatedBy: 'scripts/generate-myriad-landscape-evidence.ts',
    oracleId: ORACLE_ID,
    oracleSha256: ORACLE_SHA256,
    workspaceRevision: workspaceRevision(viewer),
    scenarios: (Object.keys(TRACE_PATHS) as (keyof typeof TRACE_PATHS)[]).map((id) =>
      runScenario(id, viewer),
    ),
  };
}

async function writeReport(outputPath: string, report: unknown) {
  writeFileSync(
    outputPath,
    await format(JSON.stringify(report), {
      ...(await resolveConfig(outputPath)),
      filepath: outputPath,
    }),
  );
}

if (import.meta.main) {
  const viewer = await loadGeneratorViewerEvidence(process.argv.slice(2));
  const revision = workspaceRevision(viewer);
  await writeReport(
    'docs/reviews/myriad-landscape-verification.json',
    generateMyriadLandscapeVerificationEvidence(viewer),
  );
  await writeReport('docs/reviews/myriad-landscape-gameplay-ai.json', {
    ...evaluateMyriadLandscapeGameplayAi(),
    workspaceRevision: revision,
  });
  console.log('wrote Myriad Landscape verification and gameplay-AI evidence');
}
