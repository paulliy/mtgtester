import { format, resolveConfig } from 'prettier';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { DecisionRequest, DecisionResponse, GameId } from '../packages/shared/src';
import { canonicalEngineStateHash } from '../packages/server/src/benchmark/replay';
import { sha256 } from '../packages/server/src/benchmark/hash';
import { createCardTestScenario } from '../packages/server/src/cards/card-test-scenarios';
import { evaluateSmotheringTitheGameplayAi } from '../packages/server/src/cards/gameplay-ai-evaluation';
import {
  loadGeneratorViewerEvidence,
  validateCurrentEvidenceSources,
  type ValidatedViewerEvidence,
} from './card-evidence-input';

const ORACLE_ID = '153376c9-dffd-458c-8ce3-a4c8269bc4e9';
const ORACLE_SHA256 = '38346bcc71227873ac4c358bd89d277f9d1f94a65e7778392c5e0aefeb7ab2c4';

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
  'packages/engine/src/view/face-down.ts',
  'packages/engine/src/view/library-top.ts',
  'packages/engine/tests/fixtures/coverage-pr09-oracle.json',
  'packages/engine/tests/fixtures/coverage-pr10-oracle.json',
  'packages/engine/tests/fixtures/coverage-pr11-oracle.json',
  'packages/engine/tests/fixtures/coverage-pr12-oracle.json',
  'packages/engine/tests/fixtures/coverage-pr13-oracle.json',
  'packages/engine/tests/fixtures/casting-statics-oracle.json',
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
  'packages/server/src/cards/casting-statics-scenarios.ts',
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
  'packages/engine/src/cards/overrides/queen-marchesa-queens-gambit-remaining.ts',
  'packages/engine/src/effects/resolve.ts',
  'packages/engine/src/index.ts',
  'packages/engine/src/sba/sba.ts',
  'packages/engine/src/state/types.ts',
  'packages/engine/src/view/spectator.ts',
  'packages/engine/tests/fail-closed-restoration.test.ts',
  'packages/engine/tests/smothering-tithe.test.ts',
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
  'scripts/generate-smothering-tithe-evidence.ts',
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
  'packages/bot/src/card-knowledge.ts',
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
  'packages/bot/src/fixes.ts',
  'packages/bot/src/index.ts',
  'packages/bot/src/policy.ts',
  'packages/bot/src/provider.ts',
  'packages/bot/src/rng.ts',
  'packages/bot/src/tactics.ts',
  'packages/bot/src/veto.ts',
  'packages/bot/src/version.ts',
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
  'packages/engine/src/cards/grammar/amount-forms.ts',
  'packages/engine/src/cards/grammar/amount.ts',
  'packages/engine/src/cards/grammar/condition.ts',
  'packages/engine/src/cards/grammar/copy.ts',
  'packages/engine/src/cards/grammar/cost.ts',
  'packages/engine/src/cards/grammar/damage.ts',
  'packages/engine/src/cards/grammar/diagnostics.ts',
  'packages/engine/src/cards/grammar/effect.ts',
  'packages/engine/src/cards/grammar/player-verb.ts',
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
  'packages/engine/src/cards/overrides/edhrec-staples.ts',
  'packages/engine/src/cards/overrides/index.ts',
  'packages/engine/src/cards/overrides/living-energy.ts',
  'packages/engine/src/cards/overrides/marchesa-the-black-rose.ts',
  'packages/engine/src/cards/overrides/mini-pilot.ts',
  'packages/engine/src/cards/overrides/necron-dynasties-remaining.ts',
  'packages/engine/src/cards/overrides/necron-dynasties.ts',
  'packages/engine/src/cards/overrides/pilot-new.ts',
  'packages/engine/src/cards/overrides/pilot-current.ts',
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
  'packages/engine/src/signals.ts',
  'packages/engine/src/stack/stack.ts',
  'packages/engine/src/state/game.ts',
  'packages/engine/src/state/objects.ts',
  'packages/engine/src/state/off-battlefield-types.ts',
  'packages/engine/src/state/queries.ts',
  'packages/engine/src/testing/candidate-definition.ts',
  'packages/engine/src/testing/card-scenario.ts',
  'packages/engine/src/testing/checkpoint-hook.ts',
  'packages/engine/src/testing/definition-transform.ts',
  'packages/engine/src/testing/diagnostics.ts',
  'packages/engine/src/testing/prepared-scenario.ts',
  'packages/engine/src/turn/mulligan.ts',
  'packages/engine/src/turn/priority.ts',
  'packages/engine/src/turn/stops.ts',
  'packages/engine/src/turn/turn.ts',
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
  'packages/engine/tests/scenarios/aberrant.json',
  'packages/engine/tests/scenarios/abraded-bluffs.json',
  'packages/engine/tests/scenarios/academy-manufactor.json',
  'packages/engine/tests/scenarios/adventurous-impulse.json',
  'packages/engine/tests/scenarios/aetherize.json',
  'packages/engine/tests/scenarios/agate-instigator.json',
  'packages/engine/tests/scenarios/ajanis-pridemate.json',
  'packages/engine/tests/scenarios/alpha-authority.json',
  'packages/engine/tests/scenarios/ant-man.json',
  'packages/engine/tests/scenarios/arbor-elf.json',
  'packages/engine/tests/scenarios/arcbound-worker.json',
  'packages/engine/tests/scenarios/behind-the-scenes.json',
  'packages/engine/tests/scenarios/beloved-princess.json',
  'packages/engine/tests/scenarios/blaze.json',
  'packages/engine/tests/scenarios/braids-arisen-nightmare.json',
  'packages/engine/tests/scenarios/burglar-rat.json',
  'packages/engine/tests/scenarios/challenger-troll.json',
  'packages/engine/tests/scenarios/chasm-skulker.json',
  'packages/engine/tests/scenarios/choked-estuary.json',
  'packages/engine/tests/scenarios/chrome-mox.json',
  'packages/engine/tests/scenarios/cloudshift.json',
  'packages/engine/tests/scenarios/cold-eyed-selkie.json',
  'packages/engine/tests/scenarios/coruscation-mage.json',
  'packages/engine/tests/scenarios/cover-of-darkness.json',
  'packages/engine/tests/scenarios/craterhoof-behemoth.json',
  'packages/engine/tests/scenarios/dauthi-embrace.json',
  'packages/engine/tests/scenarios/deaths-shadow.json',
  'packages/engine/tests/scenarios/donatellos-technique.json',
  'packages/engine/tests/scenarios/doom-blade.json',
  'packages/engine/tests/scenarios/dwarven-grunt.json',
  'packages/engine/tests/scenarios/eladamri-lord-of-leaves.json',
  'packages/engine/tests/scenarios/electrickery.json',
  'packages/engine/tests/scenarios/elvish-champion.json',
  'packages/engine/tests/scenarios/ettercap.json',
  'packages/engine/tests/scenarios/everflowing-chalice.json',
  'packages/engine/tests/scenarios/faerie-mastermind.json',
  'packages/engine/tests/scenarios/fervent-charge.json',
  'packages/engine/tests/scenarios/finale-of-devastation.json',
  'packages/engine/tests/scenarios/fleshbag-marauder.json',
  'packages/engine/tests/scenarios/flopsie.json',
  'packages/engine/tests/scenarios/flusterstorm.json',
  'packages/engine/tests/scenarios/fog.json',
  'packages/engine/tests/scenarios/forbidden-alchemy.json',
  'packages/engine/tests/scenarios/fungal-sprouting.json',
  'packages/engine/tests/scenarios/geier-reach-sanitarium.json',
  'packages/engine/tests/scenarios/glimpse-the-unthinkable.json',
  'packages/engine/tests/scenarios/goblin-king.json',
  'packages/engine/tests/scenarios/goblin-wardriver.json',
  'packages/engine/tests/scenarios/gonti-lord-of-luxury.json',
  'packages/engine/tests/scenarios/greater-sandwurm.json',
  'packages/engine/tests/scenarios/grim-monolith.json',
  'packages/engine/tests/scenarios/gruesome-fate.json',
  'packages/engine/tests/scenarios/gudul-lurker.json',
  'packages/engine/tests/scenarios/hooded-hydra.json',
  'packages/engine/tests/scenarios/howling-golem.json',
  'packages/engine/tests/scenarios/hunted-bonebrute.json',
  'packages/engine/tests/scenarios/inkwell-leviathan.json',
  'packages/engine/tests/scenarios/innocuous-rat.json',
  'packages/engine/tests/scenarios/inspiring-call.json',
  'packages/engine/tests/scenarios/kolaghan-the-storms-fury.json',
  'packages/engine/tests/scenarios/krenko-mob-boss.json',
  'packages/engine/tests/scenarios/languish.json',
  'packages/engine/tests/scenarios/lord-of-atlantis.json',
  'packages/engine/tests/scenarios/lotus-cobra.json',
  'packages/engine/tests/scenarios/mana-geyser.json',
  'packages/engine/tests/scenarios/mask-of-riddles.json',
  'packages/engine/tests/scenarios/master-of-the-pearl-trident.json',
  'packages/engine/tests/scenarios/megrim.json',
  'packages/engine/tests/scenarios/memory-erosion.json',
  'packages/engine/tests/scenarios/merrow-harbinger.json',
  'packages/engine/tests/scenarios/michelangelo.json',
  'packages/engine/tests/scenarios/mithril-coat.json',
  'packages/engine/tests/scenarios/mizzium-mortars.json',
  'packages/engine/tests/scenarios/monastery-swiftspear.json',
  'packages/engine/tests/scenarios/mox-diamond.json',
  'packages/engine/tests/scenarios/muscle-sliver.json',
  'packages/engine/tests/scenarios/myr-convert.json',
  'packages/engine/tests/scenarios/nantuko-vigilante.json',
  'packages/engine/tests/scenarios/natures-claim.json',
  'packages/engine/tests/scenarios/noble-hierarch.json',
  'packages/engine/tests/scenarios/offer-immortality.json',
  'packages/engine/tests/scenarios/ophiomancer.json',
  'packages/engine/tests/scenarios/orcish-bowmasters.json',
  'packages/engine/tests/scenarios/ox-drover.json',
  'packages/engine/tests/scenarios/path-to-exile.json',
  'packages/engine/tests/scenarios/phyrexian-metamorph.json',
  'packages/engine/tests/scenarios/plea-for-power.json',
  'packages/engine/tests/scenarios/praetors-grasp.json',
  'packages/engine/tests/scenarios/professional-face-breaker.json',
  'packages/engine/tests/scenarios/prosperous-bandit.json',
  'packages/engine/tests/scenarios/prowlers-helm.json',
  'packages/engine/tests/scenarios/ragavan-nimble-pilferer.json',
  'packages/engine/tests/scenarios/rampaging-ceratops.json',
  'packages/engine/tests/scenarios/rancid-rats.json',
  'packages/engine/tests/scenarios/ratcatcher.json',
  'packages/engine/tests/scenarios/razortrap-gorge.json',
  'packages/engine/tests/scenarios/riders-of-rohan.json',
  'packages/engine/tests/scenarios/ripjaw-raptor.json',
  'packages/engine/tests/scenarios/ruby-medallion.json',
  'packages/engine/tests/scenarios/sanguine-bond.json',
  'packages/engine/tests/scenarios/seedborn-muse.json',
  'packages/engine/tests/scenarios/seers-sundial.json',
  'packages/engine/tests/scenarios/selfless-savior.json',
  'packages/engine/tests/scenarios/serpent-of-yawning-depths.json',
  'packages/engine/tests/scenarios/shadow-rift.json',
  'packages/engine/tests/scenarios/shadow-sliver.json',
  'packages/engine/tests/scenarios/shadowmage-infiltrator.json',
  'packages/engine/tests/scenarios/shadowspear.json',
  'packages/engine/tests/scenarios/shifting-sliver.json',
  'packages/engine/tests/scenarios/shizo-deaths-storehouse.json',
  'packages/engine/tests/scenarios/silhana-ledgewalker.json',
  'packages/engine/tests/scenarios/simic-growth-chamber.json',
  'packages/engine/tests/scenarios/skeleton-key.json',
  'packages/engine/tests/scenarios/souls-attendant.json',
  'packages/engine/tests/scenarios/splinters-technique.json',
  'packages/engine/tests/scenarios/steel-leaf-champion.json',
  'packages/engine/tests/scenarios/steelburr-champion.json',
  'packages/engine/tests/scenarios/stormkeld-vanguard.json',
  'packages/engine/tests/scenarios/sun-titan.json',
  'packages/engine/tests/scenarios/sunder-shaman.json',
  'packages/engine/tests/scenarios/sylvan-library.json',
  'packages/engine/tests/scenarios/takenuma-abandoned-mire.json',
  'packages/engine/tests/scenarios/termagant-swarm.json',
  'packages/engine/tests/scenarios/tervigon.json',
  'packages/engine/tests/scenarios/the-ozolith.json',
  'packages/engine/tests/scenarios/thief-of-sanity.json',
  'packages/engine/tests/scenarios/thraben-inspector.json',
  'packages/engine/tests/scenarios/tithe-drinker.json',
  'packages/engine/tests/scenarios/trailblazers-boots.json',
  'packages/engine/tests/scenarios/triskelion.json',
  'packages/engine/tests/scenarios/troll-of-khazad-dum.json',
  'packages/engine/tests/scenarios/urzas-incubator.json',
  'packages/engine/tests/scenarios/vampire-cutthroat.json',
  'packages/engine/tests/scenarios/vapor-snag.json',
  'packages/engine/tests/scenarios/vivid-creek.json',
  'packages/engine/tests/scenarios/vorrac-battlehorns.json',
  'packages/engine/tests/scenarios/wasteland.json',
  'packages/engine/tests/scenarios/witch-enchanter.json',
  'packages/engine/tests/scenarios/zodiac-monkey.json',
  'packages/engine/tests/fixtures/silverquill-main-engine-batch1-oracle.json',
  'packages/engine/tests/fixtures/silverquill-remaining-engine-batch1-oracle.json',
  'packages/engine/tests/fixtures/token-triumph-engine-batch1-oracle.json',
  'packages/engine/tests/fixtures/token-triumph-engine-batch2-oracle.json',
  'packages/engine/tests/fixtures/token-triumph-engine-batch3-oracle.json',
  'packages/engine/tests/fixtures/w2-remaining-engine-batch1-oracle.json',
  'packages/engine/tests/fixtures/pairs-and-hand-look-oracle.json',
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
  'packages/engine/tests/arcane-denial.test.ts',
  'packages/engine/tests/delayed-triggers.test.ts',
  'packages/engine/tests/fabled-passage.test.ts',
  'packages/engine/tests/library.test.ts',
  'packages/engine/tests/myriad-landscape.test.ts',
  'packages/engine/tests/war-room.test.ts',
  'packages/server/src/cards/war-room-evidence.test.ts',
  'packages/server/src/match/session.test.ts',
  'packages/server/src/ws/server.ts',
  'scripts/generate-arcane-denial-evidence.ts',
  'scripts/generate-fabled-passage-evidence.ts',
  'scripts/generate-myriad-landscape-evidence.ts',
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
  'smothering-tithe-viewer-pay':
    'test-results/card-test-lab-Smothering-Tithe-opponent-draws-and-pays/trace.zip',
  'smothering-tithe-viewer-decline':
    'test-results/card-test-lab-Smothering-Tithe-opponent-draws-and-declines/trace.zip',
} as const;

type ScenarioId = keyof typeof TRACE_PATHS;
type Outcome = 'pay' | 'decline';

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

function choose(request: DecisionRequest, outcome: Outcome): DecisionResponse {
  const cast = request.legalActions.find((action) =>
    action.description.includes('Cast Lab Pending Spell'),
  );
  if (cast !== undefined) return { requestId: request.requestId, actionId: cast.id };
  const paymentDescription = outcome === 'pay' ? 'Pay {2}' : "Don't pay {2}";
  const payment = request.legalActions.find((action) => action.description === paymentDescription);
  if (payment !== undefined) return { requestId: request.requestId, actionId: payment.id };
  const pass = request.legalActions.find((action) => action.type === 'pass');
  const fallback = pass ?? request.legalActions[0];
  if (fallback === undefined) throw new Error('Smothering Tithe evidence request had no action');
  return { requestId: request.requestId, actionId: fallback.id };
}

function driveScenario(id: ScenarioId, outcome: Outcome) {
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
    scenario.engine.submit(choose(step.request, outcome));
    if (++decisions > 40) throw new Error(`${id} exceeded its decision budget`);
  }
  return { scenario, scenarioSha256, decisions };
}

function assertEvidence(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Smothering Tithe evidence failed: ${message}`);
}

function runScenario(id: ScenarioId, outcome: Outcome, viewer?: ValidatedViewerEvidence) {
  const first = driveScenario(id, outcome);
  const replay = driveScenario(id, outcome);
  const { scenario, scenarioSha256, decisions } = first;
  const state = scenario.engine.getState();
  const p1 = state.players.find((player) => player.id === 'P1')!;
  const secretName = `Tithe Secret ${outcome === 'pay' ? 'Pay' : 'Decline'}`;
  const treasureCount = state.battlefield.filter(
    (permanent) => permanent.controllerId === 'P2' && permanent.name === 'Treasure',
  ).length;
  const tappedP1Forests = state.battlefield.filter(
    (permanent) =>
      permanent.controllerId === 'P1' && permanent.name === 'Forest' && permanent.tapped,
  ).length;
  const finalStateSha256 = canonicalEngineStateHash(scenario.engine);
  const replayFinalStateSha256 = canonicalEngineStateHash(replay.scenario.engine);
  const eventLogSha256 = sha256(state.eventLog);
  const replayEventLogSha256 = sha256(replay.scenario.engine.getState().eventLog);
  const p2View = JSON.stringify(scenario.engine.view('P2'));
  const p3View = JSON.stringify(scenario.engine.view('P3'));
  const tracePath = viewer === undefined ? TRACE_PATHS[id] : viewer.traces[id]!.path;

  assertEvidence(scenario.metadata.oracleSha256 === ORACLE_SHA256, `${id} Oracle hash drifted`);
  assertEvidence(
    p1.hand.map((card) => card.name).join('|') === secretName,
    `${id} did not draw exactly the prepared private card`,
  );
  assertEvidence(treasureCount === (outcome === 'pay' ? 0 : 1), `${id} Treasure count drifted`);
  assertEvidence(
    tappedP1Forests === (outcome === 'pay' ? 3 : 1),
    `${id} did not consume the expected mana sources`,
  );
  assertEvidence(
    state.eventLog.some((event) => event.type === 'castSpell') &&
      state.eventLog.filter((event) => event.type === 'draw').length === 1,
    `${id} did not use the normal cast/draw path`,
  );
  assertEvidence(
    state.eventLog.some((event) =>
      outcome === 'pay'
        ? event.type === 'unlessPaid' && event.actorSeat === 'P1'
        : event.type === 'unlessNotPaid' &&
          event.actorSeat === 'P1' &&
          event.payload['reason'] === 'declined',
    ),
    `${id} did not emit the public payment result`,
  );
  assertEvidence(
    !p2View.includes(secretName) && !p3View.includes(secretName),
    `${id} leaked the draw`,
  );
  assertEvidence(
    finalStateSha256 === replayFinalStateSha256 && eventLogSha256 === replayEventLogSha256,
    `${id} was not deterministic under replayed decisions`,
  );
  assertEvidence(existsSync(tracePath), `${id} retained Playwright trace is missing`);

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
      p1Hand: p1.hand.map((card) => card.name),
      treasureCount,
      tappedP1Forests,
      drawEvents: state.eventLog.filter((event) => event.type === 'draw').length,
      paymentEvent: outcome === 'pay' ? 'unlessPaid' : 'unlessNotPaid:declined',
      p2ViewLeaksDrawnName: p2View.includes(secretName),
      p3ViewLeaksDrawnName: p3View.includes(secretName),
    },
    viewerTrace: { path: tracePath, sha256: fileSha256(tracePath) },
  };
}

export function generateSmotheringTitheVerificationEvidence(viewer?: ValidatedViewerEvidence) {
  if (viewer !== undefined) validateCurrentEvidenceSources(viewer, process.cwd());
  return {
    schemaVersion: 1,
    generatedBy: 'scripts/generate-smothering-tithe-evidence.ts',
    oracleId: ORACLE_ID,
    oracleSha256: ORACLE_SHA256,
    workspaceRevision: workspaceRevision(viewer),
    scenarios: [
      runScenario('smothering-tithe-viewer-pay', 'pay', viewer),
      runScenario('smothering-tithe-viewer-decline', 'decline', viewer),
    ],
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
    'docs/reviews/smothering-tithe-verification.json',
    generateSmotheringTitheVerificationEvidence(viewer),
  );
  writeFileSync(
    'docs/reviews/smothering-tithe-gameplay-ai.json',
    `${JSON.stringify(
      { ...evaluateSmotheringTitheGameplayAi(), workspaceRevision: revision },
      null,
      2,
    )}\n`,
  );
  console.log('wrote Smothering Tithe verification and gameplay-AI evidence');
}
