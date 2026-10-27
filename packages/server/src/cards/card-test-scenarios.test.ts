import type { DecisionRequest } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { createCardTestScenario, listCardTestScenarios } from './card-test-scenarios';
import type { CardTestScenario } from './card-test-scenarios';

function chooseAction(request: DecisionRequest): number {
  const descriptions = request.legalActions.map((action) => action.description);
  if (descriptions.includes('Eligible Talisman')) {
    expect(descriptions).toEqual(['Eligible Talisman', 'Eligible Signet', 'Find nothing']);
    return request.legalActions.find((action) => action.description === 'Eligible Talisman')!.id;
  }
  const tribute = request.legalActions.find((action) =>
    action.description.includes('Cast Tribute Mage'),
  );
  if (tribute !== undefined) return tribute.id;
  const pass = request.legalActions.find((action) => action.type === 'pass');
  return (pass ?? request.legalActions[0]!).id;
}

function runScenario() {
  const scenario = createCardTestScenario(
    'tribute-viewer-cast-search-select-resolve',
    'card-lab-test',
  );
  expect(scenario).not.toBeNull();
  const engine = scenario!.engine;
  let decisions = 0;
  for (;;) {
    const step = engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    decisions++;
    engine.submit({
      requestId: step.request.requestId,
      actionId: chooseAction(step.request),
    });
    if (decisions > 30) throw new Error('Card Test Lab scenario did not terminate');
  }
  return { scenario: scenario!, decisions };
}

describe('deterministic Card Test Lab scenarios', () => {
  it('rejects unknown scenario IDs', () => {
    expect(createCardTestScenario('unknown', 'card-lab-unknown')).toBeNull();
  });

  it('lists every registered scenario in catalog order', () => {
    expect(listCardTestScenarios().map((entry) => entry.id)).toEqual([
      'pr13-master-of-ceremonies-viewer-money',
      'pr13-securitron-squadron-viewer-squad-copy',
      'pr13-securitron-squadron-viewer-nontoken',
      'pr13-confiscation-coup-viewer-zero-mana-value',
      'pr13-confiscation-coup-viewer-pay-mana-value',
      'pr13-overwhelming-instinct-viewer-attacker-removed',
      'pr13-overwhelming-instinct-viewer-two-attackers',
      'pr13-rakdos-charm-viewer-creature-sources',
      'pr12-black-bolt-inhuman-king-viewer-lethal-voice',
      'pr12-black-bolt-inhuman-king-viewer-noncreature-pump',
      'pr12-black-bolt-inhuman-king-viewer-creature-spell',
      'pr12-dingus-staff-viewer-opponent-creature',
      'pr12-dingus-staff-viewer-own-creature',
      'pr12-sivitri-dragon-master-viewer-attack-tax',
      'pr12-sivitri-dragon-master-viewer-unaffordable-tax',
      'pr12-sivitri-dragon-master-viewer-tutor',
      'pr12-sivitri-dragon-master-viewer-wrath',
      'pr12-zurgo-and-ojutai-viewer-return',
      'pr12-zurgo-and-ojutai-viewer-keep',
      'pr12-zurgo-and-ojutai-viewer-multiplayer',
      'pr12-bloomvine-regent-claim-territory-viewer-claim-territory',
      'pr12-bloomvine-regent-claim-territory-viewer-enters',
      'pr12-marang-river-regent-coil-and-catch-viewer-coil-and-catch',
      'pr12-marang-river-regent-coil-and-catch-viewer-enters',
      'pr12-monster-manual-zoological-study-viewer-zoological-study',
      'pr12-monster-manual-zoological-study-viewer-put-creature',
      'pr11b-malakir-rebirth-viewer-return',
      'pr11b-malakir-rebirth-viewer-land-face',
      'pr11b-valakut-awakening-viewer-redraw',
      'pr11b-valakut-awakening-viewer-land-face',
      'pr11b-defacing-duskmage-viewer-prepared',
      'pr11b-defacing-duskmage-viewer-first-draw',
      'pr11b-defacing-duskmage-viewer-deathtouch',
      'pr11b-eiganjo-dynastorian-viewer-prepared',
      'pr11b-eiganjo-dynastorian-viewer-one-attacker',
      'pr11b-wandering-archaic-viewer-copy',
      'pr11b-wandering-archaic-viewer-paid',
      'pr11b-wandering-archaic-viewer-explore',
      'pr11b-wear-tear-viewer-fused',
      'pr11b-wear-tear-viewer-half',
      'pr11b-the-war-in-heaven-viewer-chapter-one',
      'pr11b-the-war-in-heaven-viewer-chapter-two',
      'pr11b-the-war-in-heaven-viewer-chapter-three',
      'pr11b-intermediate-chirography-viewer-level-two',
      'pr11b-intermediate-chirography-viewer-level-one',
      'pr11b-intermediate-chirography-viewer-level-three',
      'pr11b-urza-s-saga-viewer-construct',
      'pr11b-urza-s-saga-viewer-chapter-three',
      'pr11b-legion-s-landing-viewer-transform',
      'pr11b-legion-s-landing-viewer-two-attackers',
      'pr11b-legion-s-landing-viewer-adanto-mana',
      'pr11b-legion-s-landing-viewer-adanto-vampire',
      'pr11b-dollmaker-s-shop-viewer-unlock',
      'pr11b-dollmaker-s-shop-viewer-toy-attack',
      'pr11b-dollmaker-s-shop-viewer-multiplayer',
      'pr11b-dollmaker-s-shop-viewer-graveyard-budget',
      'pr11b-mila-crafty-companion-viewer-walker-attack',
      'pr11b-mila-crafty-companion-viewer-lukka',
      'pr11b-mila-crafty-companion-viewer-targeted-draw',
      'pr11b-mila-crafty-companion-viewer-lukka-plus',
      'pr11b-mila-crafty-companion-viewer-lukka-emblem',
      'pr11-arcane-lighthouse-viewer-positive',
      'pr11-arcane-lighthouse-viewer-negative',
      'pr11-smokestack-viewer-soot',
      'pr11-smokestack-viewer-sacrifice',
      'pr11-angel-s-grace-viewer-split-second',
      'pr11-angel-s-grace-viewer-life-floor',
      'pr11-gut-true-soul-zealot-viewer-sacrifice',
      'pr11-gut-true-soul-zealot-viewer-decline',
      'pr11-out-of-the-tombs-viewer-upkeep',
      'pr11-out-of-the-tombs-viewer-empty-library',
      'pr11-caged-sun-viewer-chosen-color',
      'pr11-caged-sun-viewer-mana',
      'pr11-caged-sun-viewer-other-color',
      'pr11-mystic-remora-viewer-draw',
      'pr11-mystic-remora-viewer-pay-upkeep',
      'pr11-mystic-remora-viewer-skip-upkeep',
      'pr11-chrome-mox-viewer-imprint',
      'pr11-chrome-mox-viewer-no-imprint',
      'pr11-gemstone-caverns-viewer-luck',
      'pr11-gemstone-caverns-viewer-no-luck',
      'pr11-teferi-s-protection-viewer-protection',
      'pr11-teferi-s-protection-viewer-phase-in',
      'pr11-mana-vault-viewer-mana',
      'pr11-mana-vault-viewer-pay-untap',
      'pr11-mana-vault-viewer-damage',
      'pr11-the-one-ring-viewer-cast',
      'pr11-the-one-ring-viewer-draw',
      'pr11-the-one-ring-viewer-upkeep',
      'pr11-clever-concealment-viewer-phase-out',
      'pr11-clever-concealment-viewer-convoke',
      'pr11-shanna-sisay-s-legacy-viewer-power',
      'pr11-shanna-sisay-s-legacy-viewer-ability-target',
      'pr11-shanna-sisay-s-legacy-viewer-spell-target',
      'pr11-basri-s-lieutenant-viewer-enters',
      'pr11-basri-s-lieutenant-viewer-multicolored',
      'pr11-basri-s-lieutenant-viewer-dies',
      'pr11-negative-zone-portal-viewer-creature',
      'pr11-negative-zone-portal-viewer-noncreature',
      'pr11-spirit-mantle-viewer-cast',
      'pr11-spirit-mantle-viewer-ability-target',
      'pr11-unquestioned-authority-viewer-cast',
      'pr10-deflecting-swat-viewer-positive',
      'pr10-deflecting-swat-viewer-negative',
      'pr10-deflecting-swat-viewer-commander',
      'pr10-deflecting-swat-viewer-no-commander',
      'pr10-bolt-bend-viewer-positive',
      'pr10-bolt-bend-viewer-negative',
      'pr10-bolt-bend-viewer-reduction',
      'pr10-bolt-bend-viewer-no-reduction',
      'pr10-reverberate-viewer-positive',
      'pr10-reverberate-viewer-negative',
      'pr10-flare-of-duplication-viewer-positive',
      'pr10-flare-of-duplication-viewer-negative',
      'pr10-flare-of-duplication-viewer-sacrifice',
      'pr10-flare-of-duplication-viewer-no-sacrifice',
      'pr10-display-of-power-viewer-positive',
      'pr10-display-of-power-viewer-negative',
      'pr10-display-of-power-viewer-cant-be-copied',
      'pr10-galvanic-iteration-viewer-positive',
      'pr10-galvanic-iteration-viewer-negative',
      'pr10-galvanic-iteration-viewer-flashback',
      'pr10-cosmic-crucible-viewer-mana',
      'pr10-cosmic-crucible-viewer-copy',
      'pr10-cosmic-crucible-viewer-once-each-turn',
      'pr10-cosmic-crucible-viewer-negative',
      'pr10-siren-stormtamer-viewer-counter-spell',
      'pr10-siren-stormtamer-viewer-counter-ability',
      'pr10-siren-stormtamer-viewer-not-your-target',
      'pr10-mana-sculpt-viewer-wizard',
      'pr10-mana-sculpt-viewer-no-wizard',
      'pr10-mister-fantastic-viewer-copy-twice',
      'pr10-mister-fantastic-viewer-opponent-trigger',
      'pr10-mister-fantastic-viewer-combat-draw',
      'pr10-mister-fantastic-viewer-combat-no-draw',
      'pr10-verrak-warped-sengir-viewer-pay-again',
      'pr10-verrak-warped-sengir-viewer-decline',
      'pr10-verrak-warped-sengir-viewer-new-target',
      'pr10-verrak-warped-sengir-viewer-no-life',
      'pr10-roaming-throne-viewer-chosen-type-doubles',
      'pr10-roaming-throne-viewer-other-type',
      'pr10-annie-joins-up-viewer-enter-damage',
      'pr10-annie-joins-up-viewer-doubles-legendary',
      'pr10-annie-joins-up-viewer-nonlegendary',
      'pr10-atarka-monument-viewer-animate',
      'pr10-atarka-monument-viewer-insufficient-cost',
      'pr10-atarka-monument-viewer-mana',
      'pr10-sarkhan-the-dragonspeaker-viewer-plus-one',
      'pr10-sarkhan-the-dragonspeaker-viewer-minus-three',
      'pr10-sarkhan-the-dragonspeaker-viewer-emblem',
      'pr10-mirage-mirror-viewer-becomes-copy',
      'pr10-mirage-mirror-viewer-insufficient-cost',
      'pr10-saheeli-sublime-artificer-viewer-servo',
      'pr10-saheeli-sublime-artificer-viewer-minus-two',
      'pr10-scute-swarm-viewer-insect',
      'pr10-scute-swarm-viewer-copy',
      'pr10-council-of-reeds-viewer-legend-rule',
      'pr10-council-of-reeds-viewer-combat-copy',
      'pr10-council-of-reeds-viewer-combat-no-copy',
      'pr10-twilight-diviner-viewer-surveil',
      'pr10-twilight-diviner-viewer-from-graveyard',
      'pr10-twilight-diviner-viewer-from-hand',
      'pr10-saheeli-radiant-creator-viewer-energy',
      'pr10-saheeli-radiant-creator-viewer-combat-copy',
      'pr10-saheeli-radiant-creator-viewer-not-enough-energy',
      'pr10-saheeli-radiant-creator-viewer-decline',
      'pr10-mocking-doppelganger-viewer-copy',
      'pr10-mocking-doppelganger-viewer-decline',
      'pr10-duplicant-viewer-exile',
      'pr10-duplicant-viewer-decline',
      'pr10-nighthawk-scavenger-viewer-empty',
      'pr10-nighthawk-scavenger-viewer-counts-types',
      'pr10-nighthawk-scavenger-viewer-own-graveyard',
      'pr10-xenagos-god-of-revels-viewer-low-devotion',
      'pr10-xenagos-god-of-revels-viewer-seven-devotion',
      'pr10-xenagos-god-of-revels-viewer-combat',
      'pr10-trazyn-the-infinite-viewer-activated',
      'pr10-trazyn-the-infinite-viewer-mana',
      'pr10-trazyn-the-infinite-viewer-scope',
      'pr10-reality-shift-viewer-manifest',
      'pr10-reality-shift-viewer-turn-face-up',
      'pr10-dragon-man-reformed-robot-viewer-power',
      'pr10-dragon-man-reformed-robot-viewer-excludes',
      'pr10-dragon-man-reformed-robot-viewer-graveyard-cast',
      'pr10-rowan-kenrith-viewer-plus-two',
      'pr10-rowan-kenrith-viewer-minus-two',
      'pr10-rowan-kenrith-viewer-emblem',
      'pr10-rowan-kenrith-viewer-partner',
      'pr10-rowan-kenrith-viewer-commander',
      'pr10-biotransference-viewer-artifact-spell',
      'pr10-biotransference-viewer-noncreature-spell',
      'pr10-biotransference-viewer-opponents-spell',
      'pr09-chaos-warp-viewer-positive',
      'pr09-chaos-warp-viewer-negative',
      'pr09-adaptive-omnitool-viewer-positive',
      'pr09-adaptive-omnitool-viewer-negative',
      'pr09-armored-skyhunter-viewer-positive',
      'pr09-armored-skyhunter-viewer-negative',
      'pr09-armored-skyhunter-viewer-aura',
      'pr09-keen-duelist-viewer-positive',
      'pr09-keen-duelist-viewer-cast',
      'pr09-keen-duelist-viewer-negative',
      'pr09-szarekh-the-silent-king-viewer-positive',
      'pr09-szarekh-the-silent-king-viewer-negative',
      'pr09-szarekh-the-silent-king-viewer-replaced-mill',
      'pr09-szarekh-the-silent-king-viewer-cast',
      'pr09-mystic-forge-viewer-positive',
      'pr09-mystic-forge-viewer-negative',
      'pr09-songbirds-blessing-viewer-positive',
      'pr09-songbirds-blessing-viewer-negative',
      'pr09-etali-viewer-positive',
      'pr09-etali-viewer-negative',
      'pr09-sunbirds-invocation-viewer-positive',
      'pr09-sunbirds-invocation-viewer-negative',
      'pr09-minds-dilation-viewer-positive',
      'pr09-minds-dilation-viewer-negative',
      'pr09-expressive-iteration-viewer-positive',
      'pr09-expressive-iteration-viewer-negative',
      'pr09-genesis-ultimatum-viewer-positive',
      'pr09-genesis-ultimatum-viewer-negative',
      'pr09-into-the-time-vortex-viewer-positive',
      'pr09-into-the-time-vortex-viewer-negative',
      'pr09-mystic-forge-viewer-activation',
      'pr09-etali-primal-conqueror-etali-primal-sickness-viewer-transform',
      'pr09-dark-confidant-viewer-positive',
      'pr09-dark-confidant-viewer-negative',
      'pr09-dream-pillager-viewer-positive',
      'pr09-dream-pillager-viewer-negative',
      'pr09-aetherworks-marvel-viewer-positive',
      'pr09-aetherworks-marvel-viewer-negative',
      'pr09-herald-of-amity-viewer-positive',
      'pr09-herald-of-amity-viewer-negative',
      'pr09-cosmic-cube-viewer-positive',
      'pr09-cosmic-cube-viewer-negative',
      'pr09-franklin-richards-ascendant-viewer-positive',
      'pr09-franklin-richards-ascendant-viewer-negative',
      'pr09-monstrous-vortex-viewer-positive',
      'pr09-monstrous-vortex-viewer-negative',
      'pr09-chimil-the-inner-sun-viewer-positive',
      'pr09-chimil-the-inner-sun-viewer-negative',
      'pr09-trumpeting-carnosaur-viewer-positive',
      'pr09-trumpeting-carnosaur-viewer-negative',
      'pr09-aetherworks-marvel-viewer-activation',
      'pr09-herald-of-amity-viewer-attack',
      'pr09-trumpeting-carnosaur-viewer-discard',
      'pr09-path-of-discovery-viewer-positive',
      'pr09-path-of-discovery-viewer-negative',
      'pr09-lurking-predators-viewer-positive',
      'pr09-lurking-predators-viewer-negative',
      'pr09-new-generation-s-technique-viewer-positive',
      'pr09-new-generation-s-technique-viewer-negative',
      'pr09-new-generation-s-technique-viewer-sneak-positive',
      'pr09-new-generation-s-technique-viewer-sneak-negative',
      'pr09-celebrate-the-mountain-king-viewer-positive',
      'pr09-celebrate-the-mountain-king-viewer-negative',
      'pr09-celebrate-the-mountain-king-viewer-exile-positive',
      'pr09-celebrate-the-mountain-king-viewer-exile-negative',
      'pr09-rabble-rousing-viewer-positive',
      'pr09-rabble-rousing-viewer-negative',
      'pr09-tibalt-s-trickery-viewer-positive',
      'pr09-tibalt-s-trickery-viewer-negative',
      'pr09-grenzo-havoc-raiser-viewer-positive',
      'pr09-grenzo-havoc-raiser-viewer-negative',
      'pr09-grenzo-havoc-raiser-viewer-goad',
      'pr09-power-pack-viewer-positive',
      'pr09-power-pack-viewer-negative',
      'pr09-improvisation-capstone-viewer-positive',
      'pr09-improvisation-capstone-viewer-negative',
      'tragic-arrogance-viewer-keeps-artifact-creature-twice',
      'tragic-arrogance-viewer-skips-missing-types',
      'aetherspouts-viewer-owner-alpha-top-beta-bottom',
      'aetherspouts-viewer-owner-alpha-bottom-beta-top',
      'boseiju-viewer-channel-decline-search',
      'boseiju-viewer-channel-legendary-discount-search-forest',
      'boseiju-viewer-land-mana',
      'olorin-viewer-spell-mastery-damage',
      'olorin-viewer-without-spell-mastery',
      'winds-of-abandon-viewer-targeted-search',
      'winds-of-abandon-viewer-overload-searches',
      'alexios-viewer-cast-and-upkeep-rotation',
      'varchild-viewer-cast-death-gains-survivors',
      'varchild-viewer-combat-creates-survivors',
      'shadrix-viewer-distinct-combat-modes',
      'shadrix-viewer-decline-combat-modes',
      'vindictive-lich-viewer-distinct-two-modes',
      'vindictive-lich-viewer-distinct-three-modes',
      'kazuul-viewer-decline',
      'kazuul-viewer-pay',
      'kazuul-viewer-other-defender',
      'akroan-horse-viewer-cast-and-gift',
      'akroan-horse-viewer-recipient-upkeep',
      'scheming-symmetry-viewer-you-and-opponent',
      'scheming-symmetry-viewer-two-opponents-empty-library',
      'wishclaw-talisman-viewer-cast-search-and-gift',
      'wishclaw-talisman-viewer-empty-library',
      'wishclaw-talisman-viewer-off-turn',
      'druid-of-purification-viewer-duplicates',
      'druid-of-purification-viewer-decline',
      'druid-of-purification-viewer-shroud',
      'mob-rule-viewer-large',
      'mob-rule-viewer-small',
      'mob-rule-viewer-cleanup',
      'cut-a-deal-viewer-full-draw',
      'cut-a-deal-viewer-empty-library',
      'cytoplast-manipulator-viewer-graft-yes',
      'cytoplast-manipulator-viewer-graft-no',
      'cytoplast-manipulator-viewer-control-duration',
      'humble-defector-viewer-draw-then-opponent-takes-control',
      'humble-defector-viewer-off-turn',
      'reins-of-power-viewer-swap-and-cleanup',
      'reins-of-power-viewer-empty-caster',
      'alicia-masters-viewer-combat-treasure-and-owner-control',
      'alicia-masters-viewer-no-noncreature-spell',
      'benevolent-offering-viewer-different-opponents',
      'benevolent-offering-viewer-same-opponent',
      'councils-judgment-viewer-tied-votes',
      'councils-judgment-viewer-unanimous-hexproof',
      'agitator-ant-viewer-accept',
      'agitator-ant-viewer-decline',
      'breena-viewer-opponent-life-aggregate',
      'duelists-heritage-viewer-single-optional-target',
      'duress-viewer',
      'thoughtseize-viewer',
      'dark-confidant-viewer',
      'authority-of-the-consuls-viewer-opponent-creature-entry',
      'archon-of-emeria-viewer-opponent-nonbasic-land-entry',
      'doorkeeper-thrull-viewer-suppresses-creature-entry-trigger',
      'hushbringer-viewer-suppresses-creature-entry-trigger',
      'karn-argent-defender-viewer-suppresses-artifact-creature-trigger',
      'doorkeeper-thrull-viewer-flash-suppresses-incoming-entry',
      'archfiend-of-ifnir-viewer-cycle-counter',
      'waste-not-viewer-opponent-discard-payoffs',
      'whispers-of-emrakul-viewer-delirium-random-discard',
      'painful-quandary-viewer-opponent-cast-choice',
      'vicious-rumors-viewer-cast-results',
      'rankle-master-of-pranks-viewer-combat-modes',
      'tinybones-joins-up-viewer-multi-player-etb-discard',
      'tinybones-trinket-thief-viewer-opponent-discard-end-step',
      'archfiend-of-ifnir-viewer-normal-cycling',
      'waste-not-viewer-noncreature-nonland-draw',
      'tinybones-joins-up-viewer-legendary-entry-mill-life',
      'hushbringer-viewer-suppresses-creature-death-trigger',
      'rankle-master-of-pranks-viewer-all-three-modes',
      'archon-of-absolution-viewer-taxes-planeswalker-attack',
      'soul-snare-viewer-exiles-planeswalker-attacker',
      'the-haunt-of-hightower-viewer-defender-discard-planeswalker-combat',
      'imp-s-mischief-viewer',
      'restoration-magic-viewer',
      'restoration-magic-viewer-cure',
      'restoration-magic-viewer-curaga',
      'reluctant-role-model-viewer',
      'reluctant-role-model-viewer-death-counter-transfer',
      'sejiri-glacier-viewer-next-turn-mother-runes',
      'bandit-s-talent-viewer',
      'bandit-s-talent-viewer-level-three-extra-draw',
      'aven-interrupter-viewer-plots-opponent-spell',
      'aven-interrupter-viewer-later-plot-cast-pays-tax',
      'tergrid-lantern-viewer-target-loses-life',
      'bilbo-s-gambit-viewer-gift-returns-spell',
      'dawn-s-truce-viewer-gift-protects-permanents',
      'perch-protection-viewer-gift-phaseout-next-turn',
      'mother-of-runes-viewer',
      'sejiri-shelter-sejiri-glacier-viewer',
      'reprieve-viewer',
      'rebuff-the-wicked-viewer',
      'hymn-to-tourach-viewer-two-random-discards',
      'bottomless-pit-viewer-next-upkeep-random-discard',
      'necrogen-mists-viewer-next-upkeep-discard-choice',
      'hypnotic-specter-viewer-unblocked-combat-discard',
      'oppression-viewer-opponent-cast-discard',
      'syphon-mind-viewer-opponents-discard-and-draw',
      'geth-s-grimoire-viewer-hymn-discard-draw-payoff',
      'rest-in-peace-viewer',
      'stone-of-erech-viewer-activation',
      'stone-of-erech-viewer-opponent-creature-death',
      'rule-of-law-viewer-single-spell-limit',
      'deafening-silence-viewer-creature-exemption',
      'archon-of-emeria-viewer-single-spell-limit',
      'planar-void-viewer-destroyed-permanent',
      'library-of-leng-viewer-effect-discard-and-draw',
      'leyline-of-the-void-viewer-opening-hand-and-destruction',
      'liliana-of-the-veil-viewer-each-player-discards',
      'liliana-of-the-veil-viewer-targeted-sacrifice',
      'liliana-of-the-veil-viewer-ultimate-piles',
      'liliana-waker-of-the-dead-viewer-discard-life-loss',
      'liliana-waker-of-the-dead-viewer-graveyard-scaled-removal',
      'liliana-waker-of-the-dead-viewer-ultimate-emblem-reanimation',
      'curse-of-disturbance-viewer-two-attackers-one-zombie',
      'promise-of-loyalty-viewer-apnap-vow-and-sacrifice',
      'cloak-of-confusion-viewer-no-damage-random-discard',
      'tergrid-front-viewer-discards-permanent-card',
      'tergrid-front-viewer-opponent-sacrifice',
      'tergrid-lantern-viewer-discard-then-paid-untap',
      'library-of-leng-viewer-no-maximum-hand-size',
      'tinybones-trinket-thief-viewer-empty-hand-activation',
      'breena-viewer-flying-blocker',
      'archfiend-of-ifnir-viewer-flying-blocker',
      'hypnotic-specter-viewer-flying-blocker',
      'aven-interrupter-viewer-flying-blocker',
      'the-haunt-of-hightower-viewer-flying-blocker',
      'doorkeeper-thrull-viewer-flying-blocker',
      'archon-of-absolution-viewer-protection-blocker',
      'tergrid-front-viewer-menace-blocker',
      'brigid-viewer-token-copy-back',
      'brigid-viewer-token-copy-front',
      'brigid-viewer-ordinary-copy-back',
      'madame-null-viewer-pay-life',
      'madame-null-viewer-decline',
      'madame-null-viewer-unfunded',
      'madame-null-viewer-blink',
      'madame-null-viewer-destroyed',
      'marchesa-viewer-first-zone-own',
      'marchesa-viewer-first-zone-opponent-owned',
      'marchesa-viewer-first-zone-no-counter',
      'marchesa-viewer-first-zone-opponent-controlled',
      'marchesa-viewer-first-zone-exiled',
      'marchesa-viewer-simultaneous-deaths',
      'marchesa-viewer-dethrone-response',
      'marchesa-viewer-dethrone-negative',
      'namor-viewer-defender-bonus',
      'namor-viewer-source-removed',
      'scriv-viewer-departed-attacker',
      'scriv-viewer-attacks-controller',
      'marchesa-viewer-granted-dethrone',
      'dragon-mage-viewer-normal-cast-wheel',
      'hunted-phantasm-viewer-opponent-tokens',
      'drakuseth-wording-viewer-three-targets',
      'drakuseth-wording-viewer-decline-others',
      'mosswort-viewer-free-adventure-face',
      'mosswort-viewer-free-cast-stack',
      'mosswort-viewer-land-play-limit',
      'regression-viewer-aura-attachment',
      'regression-viewer-mana-source-order',
      'regression-viewer-token-characteristics',
      'regression-viewer-damage-source-controller',
      'arachnoid-adaptation-viewer-target-untap',
      'riverguards-reflexes-viewer-target-untap',
      'acrobatic-leap-viewer-target-untap',
      'burst-of-strength-viewer-target-untap',
      'vines-of-the-recluse-viewer-target-untap',
      'dragonscale-boon-viewer-target-untap',
      'witchs-web-viewer-target-untap',
      'pillar-launch-viewer-target-untap',
      'bulls-strength-viewer-target-untap',
      'high-stride-viewer-target-untap',
      'wings-of-the-cosmos-viewer-target-untap',
      'tethermages-advantage-viewer-target-untap',
      'vault-skyward-viewer-target-untap',
      'leaping-ambush-viewer-target-untap',
      'escape-from-orthanc-viewer-target-untap',
      'soldier-on-viewer-target-untap',
      'faerie-guidemother-viewer-front',
      'gift-of-the-fae-viewer-normal-face',
      'tuinvale-treefolk-viewer-front',
      'oaken-boon-viewer-normal-face',
      'two-headed-hunter-viewer-front',
      'twice-the-rage-viewer-normal-face',
      'foulmire-knight-viewer-front',
      'profane-insight-viewer-normal-face',
      'profane-insight-viewer-impulse-face',
      'an-unexpected-party-viewer-front',
      'at-the-door-viewer-normal-face',
      'obyras-attendants-viewer-front',
      'desperate-parry-viewer-normal-face',
      'garenbrig-carver-viewer-front',
      'shields-might-viewer-normal-face',
      'lindblum-industrial-regency-viewer-front',
      'mage-siege-viewer-normal-face',
      'tempest-hart-viewer-front',
      'scan-the-clouds-viewer-normal-face',
      'imodanes-recruiter-viewer-front',
      'train-troops-viewer-normal-face',
      'embereth-shieldbreaker-viewer-front',
      'battle-display-viewer-normal-face',
      'gl-in-the-mighty-viewer-front',
      'easy-pickings-viewer-normal-face',
      'easy-pickings-viewer-commander-face',
      'shepherd-of-the-flock-viewer-front',
      'usher-to-safety-viewer-normal-face',
      'sagu-wildling-viewer-front',
      'roost-seek-viewer-normal-face',
      'roost-seek-viewer-impulse-face',
      'silverflame-squire-viewer-front',
      'on-alert-viewer-normal-face',
      'oakhame-ranger-viewer-front',
      'bring-back-viewer-normal-face',
      'realm-cloaked-giant-viewer-front',
      'cast-off-viewer-normal-face',
      'frolicking-familiar-viewer-front',
      'blow-off-steam-viewer-normal-face',
      'lonesome-unicorn-viewer-front',
      'rider-in-need-viewer-normal-face',
      'topaz-dragon-viewer-front',
      'entropic-cloud-viewer-normal-face',
      'horn-of-valhalla-viewer-front',
      'ysgards-call-viewer-normal-face',
      'minecart-daredevil-viewer-front',
      'ride-the-rails-viewer-normal-face',
      'curious-pair-viewer-front',
      'treats-to-share-viewer-normal-face',
      'gingerbread-hunter-viewer-front',
      'puny-snack-viewer-normal-face',
      'bilbo-baggins-burglar-viewer-front',
      'take-a-glance-viewer-normal-face',
      'smaug-the-great-calamity-viewer-front',
      'spew-flame-viewer-normal-face',
      'young-blue-dragon-viewer-front',
      'sand-augury-viewer-normal-face',
      'counterspell-viewer-own-counter',
      'counterspell-viewer-opponent-counter',
      'negate-viewer-own-counter',
      'negate-viewer-opponent-counter',
      'mana-leak-viewer-own-counter',
      'mana-leak-viewer-opponent-counter',
      'stubborn-denial-viewer-own-counter',
      'stubborn-denial-viewer-opponent-counter',
      'force-of-negation-viewer-own-counter',
      'force-of-negation-viewer-opponent-counter',
      'cyclonic-rift-viewer-normal',
      'cyclonic-rift-viewer-overload',
      'vandalblast-viewer-normal',
      'vandalblast-viewer-overload',
      'damn-viewer-normal',
      'damn-viewer-overload',
      'conclave-tribunal-viewer-convoke-szeras',
      'lab-killian-counted-target-zero-contract',
      'lab-killian-counted-target-creatures-contract',
      'changing-loyalty-viewer-replicate-two-original-countered',
      'lab-replicate-counted-targets-original-countered-contract',
      'tribute-viewer-cast-search-select-resolve',
      'gev-viewer-opponent-targets-ward',
      'nightscape-viewer-activate-regenerate-destroy',
      'thran-viewer-graveyard-departure-trigger',
      'harmonic-viewer-cast-and-double-trigger',
      'swords-viewer-exile-and-gain-life',
      'throat-viewer-destroy-nonartifact',
      'defense-viewer-pump-and-hexproof',
      'bog-viewer-exile-targeted-graveyard',
      'bust-viewer-destroy-toughness-four-or-greater',
      'defile-viewer-minus-one-per-swamp',
      'fury-viewer-double-power',
      'mutation-viewer-destroy-enchantment-make-saprolings',
      'mutilate-viewer-minus-one-per-swamp-all',
      'death-viewer-destroy-nonartifact-creatures',
      'chain-viewer-damage-equal-to-creature-count',
      'unconscious-viewer-draw-for-your-creatures',
      'camaraderie-viewer-life-draw-and-pump',
      'revelation-viewer-draw-and-life-for-power-four',
      'flayed-viewer-etb-mill-three-lifelink',
      'scythe-viewer-etb-necron-warrior',
      'trail-viewer-reveal-enters-untapped',
      'village-viewer-reveal-enters-untapped',
      'snarl-viewer-reveal-enters-untapped',
      'quake-viewer-x-damage-spares-flying',
      'prowess-viewer-pump-and-trample',
      'warden-viewer-etb-two-tapped-warriors',
      'provoke-viewer-damage-then-pump',
      'smelter-viewer-destroy-artifact-and-pump',
      'loaming-viewer-shuffle-chosen-graveyard-card',
      'chrono-viewer-sac-artifact-draw',
      'akoum-viewer-mountain-landfall-two',
      'dawn-viewer-make-lifelink-soldier',
      'rootborn-viewer-indestructible-no-token',
      'trostani-viewer-etb-two-lifelink-soldiers',
      'felidar-viewer-landfall-cat-beast',
      'nest-viewer-damage-makes-insects',
      'slate-viewer-discard-and-draw-for-creatures',
      'scarab-viewer-exile-graveyard-make-insects',
      'oak-viewer-pump-and-untap-target-player',
      'frostboil-viewer-reveal-enters-untapped',
      'vineglimmer-viewer-reveal-enters-untapped',
      'stroke-viewer-destroy-nonland-make-human',
      'gift-viewer-destroy-and-make-elephant',
      'garrison-viewer-bounce-forest-enters-tapped',
      'basilica-viewer-bounce-forest-enters-tapped',
      'pia-kiran-viewer-etb-two-thopters',
      'crackling-viewer-damage-and-greatest-sacrifice',
      'carnarium-viewer-bounce-forest-enters-tapped',
      'whirler-viewer-etb-two-thopters',
      'weaver-viewer-artifact-etb-pings-opponents',
      'spit-viewer-four-damage-to-ox',
      'sai-viewer-cast-artifact-makes-thopter',
      'rendezvous-viewer-you-and-opponent-draw-three',
      'demanding-viewer-five-damage-no-creature',
      'cryptothrall-viewer-hexproof-other-artifact-creatures',
      'boros-charm-viewer-four-damage-to-player',
      'rakdos-charm-viewer-destroy-artifact',
      'hellkite-viewer-plus-one-power-until-eot',
      'refiner-viewer-etb-draw-two-energy',
      'virtuoso-viewer-energy-makes-thopter',
      'ajani-viewer-plus-one-counter',
      'terror-viewer-etb-damage-to-player',
      'basker-viewer-plus-one-until-eot',
      'zopandrel-viewer-indestructible-counter',
      'arcane-denial-viewer-draw-zero',
      'arcane-denial-viewer-draw-two',
      'smothering-tithe-viewer-pay',
      'smothering-tithe-viewer-decline',
      'fabled-passage-viewer-search-entry-untap',
      'myriad-landscape-viewer-enters-tapped',
      'myriad-landscape-viewer-colorless-mana',
      'myriad-landscape-viewer-shared-type-search',
      'war-room-viewer-dynamic-life-activation',
      'war-room-viewer-colorless-mana',
      'forum-of-amity-viewer-surveil',
      'attune-with-aether-viewer-reveal-to-hand',
      'beacon-of-unrest-viewer-reanimate-and-shuffle',
      'canoptek-spyder-viewer-vehicle-draw',
      'canoptek-wraith-viewer-scout-same-name-search',
      'conjurers-closet-viewer-end-step-blink',
      'harvest-season-viewer-tapped-creature-count',
      'land-tax-viewer-upkeep-reveal-search',
      'mordant-dragon-viewer-combat-damage-redirect',
      'necron-deathmark-viewer-destroy-up-to-one-and-mill',
      'plasmancer-viewer-reveal-swamp',
      'sylvan-reclamation-viewer-exile-up-to-two',
      'sylvan-reclamation-viewer-basic-landcycling',
      'thunderfoot-baloth-viewer-lieutenant',
      'tomb-fortress-viewer-mill-then-return',
      'voice-of-many-viewer-draw-per-opponent',
      'foe-razer-regent-viewer-fight-and-grow',
      'hunting-wilds-viewer-kicked',
      'loran-of-the-third-path-viewer-destroy-up-to-one',
      'loran-of-the-third-path-viewer-tap-draw',
      'rishkar-viewer-counters-and-mana',
      'vastwood-surge-viewer-kicked',
      'frontier-siege-viewer-khans-mana',
      'frontier-siege-viewer-dragons-fight',
      'kairi-viewer-bounce-total-six',
      'kairi-viewer-mill-and-return',
      'will-of-the-mardu-viewer-choose-both',
      'aether-channeler-viewer-bounce-another',
      'aether-channeler-viewer-bird',
      'aether-channeler-viewer-draw',
      'return-to-nature-viewer-destroy-enchantment',
      'return-to-nature-viewer-exile-graveyard-card',
      'mystic-sanctuary-viewer-untapped-return',
      'brokers-hideout-viewer-sacrifice-and-search',
      'sweet-gum-recluse-viewer-new-creatures',
      'sweet-gum-recluse-viewer-flash-cascade',
      'sweet-gum-recluse-viewer-reach-block',
      'kogla-viewer-enters-fight',
      'kogla-viewer-bounce-and-attack',
      'opponent-graveyard-viewer-reanimate',
      'retrofitter-foundry-viewer-servo-thopter-construct',
      'aether-hub-viewer-energy-any-color',
      'aether-hub-viewer-colorless',
      'solar-transformer-viewer-cast-and-energy-mana',
      'solar-transformer-viewer-colorless',
      'bespoke-battlewagon-viewer-energy-and-crew',
      'bespoke-battlewagon-viewer-animate-and-draw',
      'bespoke-battlewagon-viewer-tap-target',
      'endless-atlas-viewer-same-name-draw',
      'endless-atlas-viewer-mixed-names-blocked',
      'sceptre-of-eternal-glory-viewer-three-black',
      'sceptre-of-eternal-glory-viewer-one-mana',
      'weathered-wayfarer-viewer-reveal-land',
      'weathered-wayfarer-viewer-equal-lands-blocked',
      'idol-of-oblivion-viewer-token-then-draw',
      'idol-of-oblivion-viewer-eldrazi',
      'mistveil-plains-viewer-bottom-of-library',
      'mistveil-plains-viewer-one-white-blocked',
      'carrion-feeder-viewer-sacrifice',
      'carrion-feeder-viewer-cant-block',
      'nullmage-shepherd-viewer-tap-four',
      'sage-of-fables-viewer-wizard-counter-draw',
      'illuminor-szeras-viewer-sacrifice-for-black',
      'peema-trailblazer-viewer-exhaust',
      'peema-trailblazer-viewer-combat-energy',
      'soul-guide-lantern-viewer-enters-exile',
      'soul-guide-lantern-viewer-exile-graveyards',
      'soul-guide-lantern-viewer-draw',
      'ghost-ark-viewer-crew-and-unearth',
      'flare-of-denial-viewer-sacrifice-counter',
      'flare-of-malice-viewer-sacrifice-edict',
      'blasphemous-edict-viewer-pay-b',
      'dread-return-viewer-flashback',
      'raffines-guidance-viewer-graveyard-recast',
      'their-number-is-legion-viewer-graveyard-x',
      'anrakyr-the-traveller-viewer-cast-for-life',
      'toxic-deluge-viewer-pay-two-life',
      'conclave-tribunal-viewer-convoke',
      'hour-of-reckoning-viewer-convoke',
      'killian-ink-duelist-viewer-reduced-bolt',
      'dragonkin-berserker-viewer-reduced-boast',
      'convergence-of-dominion-viewer-cheap-unearth',
      'kogla-and-yidaro-viewer-enter-fight',
      'kogla-and-yidaro-viewer-discard',
      'changing-loyalty-viewer-replicate',
      'changing-loyalty-viewer-steal',
      'grim-haruspex-viewer-morph',
      'dream-devourer-viewer-foretell',
      'dream-devourer-viewer-foretold-cast',
      'triarch-praetorian-viewer-unearth',
      'canoptek-tomb-sentinel-viewer-unearth-exile',
      'glen-elendra-archmage-viewer-counter-persist',
      'flayer-of-the-hatebound-viewer-undying-damage',
      'kambal-viewer-opponent-noncreature-spell',
      'gleeful-arsonist-viewer-burn-and-undying',
      'shard-of-the-nightbringer-viewer-cast-drain',
      'sautekh-immortal-viewer-flash-counters',
      'iron-apprentice-viewer-dies-moves-counters',
      'vigean-graftmage-viewer-graft-and-untap',
      'pensive-professor-viewer-increment-draw',
      'elite-scaleguard-viewer-bolster-and-tap',
      'forgotten-ancient-viewer-cast-and-move',
      'captain-america-skybound-viewer-battalion',
      'finneas-ace-archer-viewer-counters-then-draw',
      'kutzil-malamet-exemplar-viewer-above-base-draw',
      'the-fantasticar-viewer-fourth-noncreature',
      'unbreakable-formation-viewer-addendum-main-phase',
      'first-family-viewer-colors-draw-gain',
      'call-forth-the-tempest-viewer-other-spells-damage',
      'crystal-inhuman-princess-viewer-colors-damage',
      'rumor-gatherer-viewer-scry-then-draw',
      'belladonna-took-viewer-three-tokens',
      'lockjaw-viewer-counter-and-unblockable',
      'the-thing-viewer-counters-and-double',
      'aetheric-amplifier-viewer-double-counters',
      'cranial-plating-viewer-instant-attach',
      'cranial-plating-viewer-spell-on-stack-artifact-count',
      'mask-of-memory-viewer-draw-discard',
      'resurrection-orb-viewer-lifelink-and-return',
      'sunforger-viewer-unattach-search-and-cast',
      'screams-from-within-viewer-return-and-enchant',
      'ghoulish-impetus-viewer-return-at-end-step',
      'ghoulish-impetus-viewer-goaded-attack',
      'ghoulish-impetus-viewer-goaded-opponent-attack',
      'gift-of-immortality-viewer-owner-return-then-aura',
      'ajanis-chosen-viewer-aura-moves-to-cat',
      'ajanis-chosen-viewer-enchantment-makes-cat',
      'shielded-by-faith-viewer-attach-to-entering-creature',
      'shielded-by-faith-viewer-opponent-creature-enters',
      'forum-filibuster-viewer-inkling-and-aura',
      'forum-filibuster-viewer-equipment-return',
      'karametras-favor-viewer-granted-mana-pays-spell',
      'redemption-arc-viewer-exile-enchanted-creature',
      'redemption-arc-viewer-indestructible-goaded-attack',
      'redemption-arc-viewer-goaded-opponent-attack',
      'fallen-ideal-viewer-sacrifice-then-return',
      'fallen-ideal-viewer-flying-attack',
      'kor-spiritdancer-viewer-aura-cast-draw-and-pump',
      'kor-spiritdancer-viewer-second-aura-grows-it',
      'hateful-eidolon-viewer-enchanted-creature-dies-draw',
      'hateful-eidolon-viewer-two-auras-draw-two',
      'hateful-eidolon-viewer-combat-lifelink',
      'martial-impetus-viewer-attack-pump',
      'martial-impetus-viewer-goaded-opponent-attack',
      'killian-decisive-mentor-viewer-tap-goad-and-attack-draw',
      'killian-decisive-mentor-viewer-goaded-opponent-attack',
      'angelic-destiny-viewer-angel-then-return',
      'angelic-destiny-viewer-flying-first-strike-angel-combat',
      'sheltered-by-ghosts-viewer-exile-and-lifelink',
      'sheltered-by-ghosts-viewer-ward-counters-opponent-spell',
      'eldrazi-conscription-viewer-annihilator',
      'eldrazi-conscription-viewer-trample',
      'curse-of-bounty-viewer-untap-on-attack',
      'curse-of-bounty-viewer-opponent-attacks',
      'eidolon-of-countless-battles-viewer-bestow',
      'eidolon-of-countless-battles-viewer-creature-and-aura-counts',
      'animate-dead-viewer-reanimate',
      'animate-dead-viewer-aura-leaves-sacrifices',
      'dragon-tempest-viewer-dragon-deals-damage',
      'scourge-of-valkas-viewer-dragons-deal-damage',
      'tyrants-familiar-viewer-lieutenant-attack',
      'brash-taunter-viewer-fight-and-reflect',
      'tomb-blade-viewer-sacrifice-or-lose',
      'duelists-heritage-viewer-double-strike-attacker',
      'thunderbreak-regent-viewer-opponent-targets-dragon',
      'invisible-woman-viewer-pay-pump-unblockable',
      'flameblast-dragon-viewer-target-then-pay-x',
      'territorial-aetherkite-viewer-pay-energy-damage',
      'arcbond-viewer-reflect-damage',
      'thundermaw-hellkite-viewer-damage-and-tap-fliers',
      'backlash-viewer-tap-and-reflect',
      'guard-gomazoa-viewer-blocks-and-takes-no-damage',
      'selfless-squire-viewer-prevent-and-grow',
      'deflecting-palm-viewer-chosen-source-reflects',
      'comeuppance-viewer-prevent-and-reflect',
      'michiko-konda-viewer-damage-makes-opponent-sacrifice',
      'delirium-viewer-tap-damage-and-prevent',
      'planeswalker-attack-viewer-loyalty',
      'firemane-commando-viewer-own-attack',
      'firemane-commando-viewer-other-attack-elsewhere',
      'firemane-commando-viewer-other-attack-at-you',
      'breena-viewer-attack-more-life',
      'ever-watching-threshold-viewer-attacked-you',
      'ever-watching-threshold-viewer-attacked-planeswalker',
      'ever-watching-threshold-viewer-attacked-elsewhere',
      'mangara-viewer-two-attackers',
      'mangara-viewer-one-attacker',
      'tomik-viewer-affinity-for-planeswalkers',
      'tomik-viewer-attack-drain-and-draw',
      'frontier-warmonger-viewer-menace',
      'tenuous-truce-viewer-end-step',
      'tenuous-truce-viewer-you-attack',
      'tenuous-truce-viewer-they-attack',
      'wall-of-tears-viewer-blocked-creature-returns',
      'human-torch-viewer-keywords-and-damage-copy',
      'promise-of-loyalty-viewer-vowed-creature-cant-attack-you',
      'lightning-runner-viewer-pay-energy-extra-combat',
      'firkraag-viewer-dragon-attack-goads',
      'firkraag-viewer-goaded-damage-draws',
      'eriette-viewer-enchanted-cant-attack-you',
      'eriette-viewer-end-step-drain',
      'rite-of-the-raging-storm-viewer-named-cant-attack-you',
      'rite-of-the-raging-storm-viewer-upkeep-token',
      'nils-viewer-end-step-counters',
      'nils-viewer-counters-attack-tax',
      'combat-calligrapher-viewer-inkling-cant-attack-you',
      'combat-calligrapher-viewer-attacker-creates-inkling',
      'goblin-spymaster-viewer-opponent-end-step-token',
      'toby-viewer-beast-cant-block-alone',
      'toby-viewer-flying-with-four-tokens',
      'life-of-the-party-viewer-attack-pump',
      'life-of-the-party-viewer-goaded-copies',
      'kardur-viewer-must-attack-not-you',
      'kardur-viewer-attacker-dies-drain',
      'galactus-viewer-attacks-most-life',
      'galactus-viewer-herald-lifts-requirement',
      'silver-surfer-viewer-search-galactus',
      'silver-surfer-viewer-attack-that-player',
      'taunt-viewer-goad-and-cant-block',
      'hexmark-viewer-needs-six-blockers',
      'champion-of-lambholt-viewer-weaker-cant-block',
      'pramikon-viewer-nearest-opponent',
      'teyo-viewer-minus-two-direction',
      'teyo-viewer-wall-and-plus-one',
      'triarch-stalker-viewer-menace',
      'illusionists-gambit-viewer-remove-and-redirect',
      'moraug-viewer-landfall-extra-combat',
      'sirens-call-viewer-attack-or-die',
      'wars-toll-viewer-taps-lands-and-forces-attack',
      'willie-lumpkin-viewer-draw-then-cant-attack',
      'fight-or-flight-viewer-separate',
      'fight-or-flight-viewer-choose',
      'master-warcraft-viewer-choose-attackers-and-blocks',
      'master-warcraft-viewer-assign-chosen-attackers',
      'bess-soul-nourisher-viewer-counter-and-pump',
      'mikey-and-leo-viewer-counter-draw',
      'satoru-viewer-free-cast-draws',
      'keeper-of-secrets-viewer-flashback',
      'river-kelpie-viewer-flashback-and-persist',
      'aurora-phoenix-viewer-cascade-return',
      'aurora-phoenix-viewer-cast-cascade-flying',
      'watcher-for-tomorrow-viewer-hideaway-leaves',
      'psychomancer-viewer-artifact-drain',
      'shard-of-the-void-dragon-viewer-attack-edict',
      'scavenging-ooze-viewer-exile-creature',
      'imotekh-viewer-phaeron-and-strategist',
      'the-ooze-viewer-leave-and-exile',
      'god-eternal-rhonas-viewer-double-and-return',
      'candlekeep-sage-viewer-commander-enters-and-leaves',
      'flickerwisp-viewer-exile-and-return',
      'venser-viewer-plus-two-blink',
      'venser-viewer-minus-one-unblockable',
      'venser-viewer-minus-eight-emblem',
      'puppeteer-clique-viewer-steal-attack-exile',
      'puppeteer-clique-viewer-persist',
      'cryptek-viewer-dies-and-returns-tapped',
      'living-death-viewer-swap',
      'technomancer-viewer-mill-and-return',
      'victimize-viewer-sacrifice-and-return',
      'body-launderer-viewer-connive',
      'body-launderer-viewer-return',
    ]);
  });

  it('runs Tribute Mage through normal casting, payment, priority, search, and shuffle', () => {
    const { scenario, decisions } = runScenario();
    const state = scenario.engine.getState();
    const player = state.players.find(({ id }) => id === 'P1')!;

    expect(decisions).toBeGreaterThanOrEqual(2);
    expect(player.hand.map((card) => card.name)).toContain('Eligible Talisman');
    expect(state.battlefield.map((permanent) => permanent.name)).toContain('Tribute Mage');
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
    expect(state.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
  });

  it('resets to the same state and produces the same authoritative event stream', () => {
    const first = runScenario().scenario.engine.getState();
    const second = runScenario().scenario.engine.getState();
    expect(second.eventLog).toEqual(first.eventLog);
    expect(second.players[0]!.hand.map((card) => card.name)).toEqual(
      first.players[0]!.hand.map((card) => card.name),
    );
  });
});

interface Choice {
  actionId: number;
  targets?: Array<{ slot: number; choice: string }>;
}

type Chooser = (request: DecisionRequest, scenario: CardTestScenario) => Choice;

/** Map every targetable object id in the arranged state to its card name. */
function objectNames(scenario: CardTestScenario): Map<string, string> {
  const names = new Map<string, string>();
  const state = scenario.engine.getState();
  for (const perm of state.battlefield) names.set(perm.id, perm.name);
  for (const player of state.players) {
    names.set(player.id, player.id);
    for (const card of player.graveyard) names.set(card.id, card.name);
    for (const card of player.hand) names.set(card.id, card.name);
  }
  for (const entry of state.stack) names.set(entry.id, entry.description);
  return names;
}

/** Pick the action whose description matches, filling any target slot with the named object. */
function chooseWithTarget(
  request: DecisionRequest,
  scenario: CardTestScenario,
  descriptionIncludes: string,
  targetName?: string,
): Choice | null {
  const action = request.legalActions.find((candidate) =>
    candidate.description.includes(descriptionIncludes),
  );
  if (action === undefined) return null;
  if (targetName === undefined) return { actionId: action.id };
  const slots =
    (action.interaction as { targetSlots?: Array<{ slot: number; options: string[] }> } | undefined)
      ?.targetSlots ?? [];
  const names = objectNames(scenario);
  const slot = slots[0];
  if (slot === undefined) return { actionId: action.id };
  const choice = slot.options.find((id) => names.get(id) === targetName);
  if (choice === undefined) {
    throw new Error(
      `${descriptionIncludes}: no target named ${targetName} among [${slot.options
        .map((id) => names.get(id) ?? id)
        .join(', ')}]`,
    );
  }
  return { actionId: action.id, targets: [{ slot: slot.slot, choice }] };
}

function passChoice(request: DecisionRequest): Choice {
  const pass = request.legalActions.find((action) => action.type === 'pass');
  return { actionId: (pass ?? request.legalActions[0]!).id };
}

function runScenarioWith(scenarioId: string, chooser: Chooser) {
  const scenario = createCardTestScenario(scenarioId, 'card-lab-test');
  expect(scenario).not.toBeNull();
  const engine = scenario!.engine;
  let decisions = 0;
  for (;;) {
    const step = engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    decisions++;
    const choice = chooser(step.request, scenario!);
    engine.submit({ requestId: step.request.requestId, ...choice });
    if (decisions > 40) throw new Error(`${scenarioId} did not terminate`);
  }
  return { scenario: scenario!, decisions };
}

function arcaneDenialChoice(drawCount: 0 | 2): Chooser {
  return (request, scenario) => {
    const cast = chooseWithTarget(request, scenario, 'Cast Arcane Denial', 'Lab Pending Spell');
    if (cast !== null) return cast;
    const order = request.legalActions.find((action) =>
      action.description.includes('targeted spell controller'),
    );
    if (order !== undefined) return { actionId: order.id };
    const draw = request.legalActions.find(
      (action) => action.description === `Draw ${drawCount} cards`,
    );
    if (draw !== undefined) return { actionId: draw.id };
    return passChoice(request);
  };
}

function smotheringTitheChoice(outcome: 'pay' | 'decline'): Chooser {
  return (request, scenario) => {
    const cast = chooseWithTarget(request, scenario, 'Cast Lab Pending Spell');
    if (cast !== null) return cast;
    const payment = request.legalActions.find((action) =>
      outcome === 'pay' ? action.description === 'Pay {2}' : action.description === "Don't pay {2}",
    );
    if (payment !== undefined) return { actionId: payment.id };
    return passChoice(request);
  };
}

function fabledPassageChoice(request: DecisionRequest): Choice {
  const activate = request.legalActions.find((action) =>
    action.description.includes('Search for a basic land'),
  );
  if (activate !== undefined) return { actionId: activate.id };
  const island = request.legalActions.find((action) =>
    action.description.includes('Put Island onto the battlefield tapped'),
  );
  if (island !== undefined) return { actionId: island.id };
  return passChoice(request);
}

function myriadLandscapeEntryChoice(request: DecisionRequest): Choice {
  const play = request.legalActions.find((action) =>
    action.description.includes('Play Myriad Landscape'),
  );
  if (play !== undefined) return { actionId: play.id };
  return passChoice(request);
}

function myriadLandscapeSearchChoice(request: DecisionRequest): Choice {
  const activate = request.legalActions.find((action) =>
    action.description.includes('Search for up to two basic lands'),
  );
  if (activate !== undefined) return { actionId: activate.id };
  const pair = request.legalActions.find(
    (action) =>
      action.description.includes('Island') && action.description.includes('Myriad Shared Dual'),
  );
  if (pair !== undefined) return { actionId: pair.id };
  return passChoice(request);
}

function myriadLandscapeManaChoice(request: DecisionRequest): Choice {
  const cast = request.legalActions.find((action) =>
    action.description.includes('Cast Myriad Mana Sink'),
  );
  if (cast !== undefined) return { actionId: cast.id };
  return passChoice(request);
}

/**
 * Activates War Room's draw ability and nothing else. The sink stays in hand on purpose: paying
 * {3} taps every Forest, so casting it afterwards could not demonstrate the mana clause.
 */
function warRoomDrawChoice(request: DecisionRequest): Choice {
  const activate = request.legalActions.find((action) =>
    action.description.startsWith('War Room: Pay life'),
  );
  if (activate !== undefined) return { actionId: activate.id };
  return passChoice(request);
}

function warRoomManaChoice(request: DecisionRequest): Choice {
  const cast = request.legalActions.find((action) =>
    action.description.includes('Cast War Room Mana Sink'),
  );
  if (cast !== undefined) return { actionId: cast.id };
  return passChoice(request);
}

function assertWarRoomProjections(scenario: CardTestScenario) {
  const state = scenario.engine.getState();
  for (const viewer of ['P1', 'P2', 'P3', 'P4'] as const) {
    const projection = scenario.engine.playerState(viewer);
    expect(projection.viewerSeat).toBe(viewer);
    expect(projection.seats).toHaveLength(4);
    for (const player of state.players) {
      const seat = projection.seats.find((seat) => seat.seat === player.id)!;
      expect(seat.life).toBe(player.life);
      expect(seat.handSize).toBe(player.hand.length);
      if (player.id === viewer) {
        expect(seat.hand?.map((card) => card.name)).toEqual(player.hand.map((card) => card.name));
      } else {
        expect(seat.hand).toBeNull();
        for (const card of player.hand) {
          expect(JSON.stringify(projection)).not.toContain(card.id);
        }
      }
    }
    expect(
      projection.battlefield.map((permanent) => ({
        name: permanent.name,
        tapped: permanent.tapped,
      })),
    ).toEqual(
      state.battlefield.map((permanent) => ({ name: permanent.name, tapped: permanent.tapped })),
    );
    expect(projection.stack.map((entry) => entry.description)).toEqual(
      state.stack.map((entry) => entry.description),
    );
  }
}

describe('deterministic Card Test Lab scenarios — registered card scenarios', () => {
  it("Gev: an opponent's spell targeting Gev triggers ward — pay 2 life, countered when declined", () => {
    const { scenario } = runScenarioWith('gev-viewer-opponent-targets-ward', (request, sc) => {
      const descriptions = request.legalActions.map((action) => action.description);
      // Gev's controller declines the life payment so the spell is countered.
      const decline = request.legalActions.findIndex((action) =>
        /be countered/.test(action.description),
      );
      if (decline >= 0) return { actionId: request.legalActions[decline]!.id };
      const cast = chooseWithTarget(request, sc, 'Lab Doom', 'Gev, Scaled Scorch');
      if (cast !== null) return cast;
      expect(descriptions.every((d) => !d.includes('Gev')) || decline >= 0).toBe(true);
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    const names = state.battlefield.map((perm) => perm.name);
    expect(names).toContain('Gev, Scaled Scorch'); // ward countered the spell
    expect(names).not.toContain('Lab Doom');
    const p1 = state.players.find((player) => player.id === 'P1')!;
    expect(p1.graveyard.map((card) => card.name)).toContain('Lab Doom');
    expect(p1.life).toBe(40);
    expect(
      state.eventLog.some(
        (event) =>
          JSON.stringify(event.payload).includes('Ward') ||
          JSON.stringify(event.payload).includes('ward'),
      ),
    ).toBe(true);
  });

  it('Nightscape Familiar: regeneration shield replaces the next destruction', () => {
    let activated = false;
    const { scenario } = runScenarioWith(
      'nightscape-viewer-activate-regenerate-destroy',
      (request, sc) => {
        const state = sc.engine.getState();
        const shieldOnStack = state.stack.some((entry) =>
          JSON.stringify(entry).includes('egenerate'),
        );
        if (!activated && !shieldOnStack) {
          const activate = request.legalActions.find(
            (action) =>
              action.type === 'activateAbility' && action.description.includes('Nightscape'),
          );
          if (activate !== undefined) {
            activated = true;
            return { actionId: activate.id };
          }
        }
        // Let the regenerate ability resolve before casting the Doom, so the shield is active.
        if (shieldOnStack) return passChoice(request);
        if (activated) {
          const cast = chooseWithTarget(request, sc, 'Lab Doom', 'Nightscape Familiar');
          if (cast !== null) return cast;
        }
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const familiar = state.battlefield.find((perm) => perm.name === 'Nightscape Familiar');
    expect(familiar).toBeDefined();
    expect(familiar!.tapped).toBe(true);
    // The destruction was prevented by the shield rather than the Doom simply missing.
    expect(
      state.eventLog.some(
        (event) =>
          event.type === 'regenerated' &&
          JSON.stringify(event.payload).includes('Nightscape Familiar'),
      ),
    ).toBe(true);
    expect(
      state.eventLog.some(
        (event) => event.type === 'destroy' && JSON.stringify(event.payload).includes('Nightscape'),
      ),
    ).toBe(false);
  });

  it('Thran Vigil: an artifact leaving your graveyard on your turn puts a counter on your creature', () => {
    const { scenario } = runScenarioWith(
      'thran-viewer-graveyard-departure-trigger',
      (request, sc) => {
        const activate = request.legalActions.find(
          (action) => action.type === 'activateAbility' && action.description.includes('Grave'),
        );
        if (activate !== undefined) {
          const filled = chooseWithTarget(request, sc, 'Grave', 'Eligible Talisman');
          if (filled !== null) return filled;
          return { actionId: activate.id };
        }
        const triggerTarget = request.legalActions.find((action) =>
          action.description.includes('Grave Picker'),
        );
        if (triggerTarget !== undefined && request.legalActions.length <= 2) {
          return { actionId: triggerTarget.id };
        }
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    expect(p1.hand.map((card) => card.name)).toContain('Eligible Talisman');
    expect(p1.graveyard.map((card) => card.name)).not.toContain('Eligible Talisman');
    const picker = state.battlefield.find((perm) => perm.name === 'Grave Picker');
    expect(picker).toBeDefined();
    expect(picker!.counters['+1/+1']).toBe(1);
  });

  it('Harmonic Prodigy: the Lab Shaman enter trigger fires exactly twice and gains 2 life', () => {
    const { scenario } = runScenarioWith(
      'harmonic-viewer-cast-and-double-trigger',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Lab Shaman');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    expect(p1.life).toBe(42);
    expect(state.battlefield.map((perm) => perm.name)).toContain('Lab Shaman');
    const triggerEvents = state.eventLog.filter(
      (event) =>
        event.type === 'triggerOnStack' && JSON.stringify(event.payload).includes('Lab Shaman'),
    );
    expect(triggerEvents.length).toBe(2);
  });

  it('Swords to Plowshares: exiles Lab Ox and its controller gains 4 life', () => {
    const { scenario } = runScenarioWith('swords-viewer-exile-and-gain-life', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Swords to Plowshares', 'Lab Ox');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    const p2 = state.players.find((player) => player.id === 'P2')!;
    expect(state.exile.some((object) => object.name === 'Lab Ox')).toBe(true);
    expect(state.battlefield.some((permanent) => permanent.name === 'Lab Ox')).toBe(false);
    expect(p2.graveyard.map((card) => card.name)).not.toContain('Lab Ox');
    expect(p2.life).toBe(44);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Go for the Throat: destroys Lab Ox and leaves the artifact creature', () => {
    const { scenario } = runScenarioWith('throat-viewer-destroy-nonartifact', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Go for the Throat', 'Lab Ox');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    expect(state.battlefield.some((permanent) => permanent.name === 'Lab Ox')).toBe(false);
    expect(state.battlefield.some((permanent) => permanent.name === 'Lab Servo')).toBe(true);
    const p2 = state.players.find((player) => player.id === 'P2')!;
    expect(p2.graveyard.map((card) => card.name)).toContain('Lab Ox');
  });

  it('Blossoming Defense: pumps Lab Ox to 6/6 and grants hexproof', () => {
    const { scenario } = runScenarioWith('defense-viewer-pump-and-hexproof', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Blossoming Defense', 'Lab Ox');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    const ox = state.battlefield.find((permanent) => permanent.name === 'Lab Ox');
    expect(ox).toBeDefined();
    expect(
      state.eventLog.some(
        (event) =>
          event.type === 'grantKeyword' && JSON.stringify(event.payload).includes('hexproof'),
      ),
    ).toBe(true);
    expect(
      state.eventLog.some(
        (event) => event.type === 'pump' && JSON.stringify(event.payload).includes('Lab Ox'),
      ),
    ).toBe(true);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Bojuka Bog: exiles the targeted graveyard and leaves yours', () => {
    const { scenario } = runScenarioWith('bog-viewer-exile-targeted-graveyard', (request, sc) => {
      const play = chooseWithTarget(request, sc, 'Bojuka Bog', 'P2');
      if (play !== null) return play;
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const p2 = state.players.find((player) => player.id === 'P2')!;
    const bog = state.battlefield.find((permanent) => permanent.name === 'Bojuka Bog');
    expect(bog).toBeDefined();
    expect(bog?.tapped).toBe(true);
    expect(p2.graveyard.map((card) => card.name)).not.toContain('Lab Ox');
    expect(state.exile.some((object) => object.name === 'Lab Ox')).toBe(true);
    expect(p1.graveyard.map((card) => card.name)).toContain('Lab Servo');
  });

  it('Citywide Bust: destroys Lab Ox and leaves Lab Servo', () => {
    const { scenario } = runScenarioWith(
      'bust-viewer-destroy-toughness-four-or-greater',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Citywide Bust');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    expect(state.battlefield.some((permanent) => permanent.name === 'Lab Ox')).toBe(false);
    expect(state.battlefield.some((permanent) => permanent.name === 'Lab Servo')).toBe(true);
    const p2 = state.players.find((player) => player.id === 'P2')!;
    expect(p2.graveyard.map((card) => card.name)).toContain('Lab Ox');
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Defile: Lab Ox becomes 2/2 from two Swamps; Lab Servo is untargeted', () => {
    const { scenario } = runScenarioWith('defile-viewer-minus-one-per-swamp', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Defile', 'Lab Ox');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const ox = spec.battlefield.find((permanent) => permanent.name === 'Lab Ox');
    const servo = spec.battlefield.find((permanent) => permanent.name === 'Lab Servo');
    expect(ox).toBeDefined();
    expect(servo).toBeDefined();
    expect(ox?.power).toBe(2);
    expect(ox?.toughness).toBe(2);
    expect(servo?.power).toBe(1);
    expect(servo?.toughness).toBe(1);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Unleash Fury: Lab Ox becomes 8/4', () => {
    const { scenario } = runScenarioWith('fury-viewer-double-power', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Unleash Fury', 'Lab Ox');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const ox = spec.battlefield.find((permanent) => permanent.name === 'Lab Ox');
    expect(ox?.power).toBe(8);
    expect(ox?.toughness).toBe(4);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Aura Mutation: destroys Lab Hex and makes three Saprolings', () => {
    const { scenario } = runScenarioWith(
      'mutation-viewer-destroy-enchantment-make-saprolings',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Aura Mutation', 'Lab Hex');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    expect(state.battlefield.some((permanent) => permanent.name === 'Lab Hex')).toBe(false);
    expect(state.battlefield.some((permanent) => permanent.name === 'Lab Ox')).toBe(true);
    expect(state.battlefield.filter((permanent) => permanent.name === 'Saproling')).toHaveLength(3);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Mutilate: Lab Ox becomes 2/2 and Lab Servo dies', () => {
    const { scenario } = runScenarioWith(
      'mutilate-viewer-minus-one-per-swamp-all',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Mutilate');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const ox = spec.battlefield.find((permanent) => permanent.name === 'Lab Ox');
    expect(ox?.power).toBe(2);
    expect(ox?.toughness).toBe(2);
    expect(spec.battlefield.some((permanent) => permanent.name === 'Lab Servo')).toBe(false);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Their Name Is Death: destroys Lab Ox and leaves the artifact creature', () => {
    const { scenario } = runScenarioWith(
      'death-viewer-destroy-nonartifact-creatures',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Their Name Is Death');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    expect(state.battlefield.some((permanent) => permanent.name === 'Lab Ox')).toBe(false);
    expect(state.battlefield.some((permanent) => permanent.name === 'Lab Servo')).toBe(true);
    const p2 = state.players.find((player) => player.id === 'P2')!;
    expect(p2.graveyard.map((card) => card.name)).toContain('Lab Ox');
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Chain Reaction: two creatures take 2 damage; Lab Servo dies', () => {
    const { scenario } = runScenarioWith(
      'chain-viewer-damage-equal-to-creature-count',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Chain Reaction');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const ox = spec.battlefield.find((permanent) => permanent.name === 'Lab Ox');
    expect(ox?.power).toBe(4);
    expect(ox?.toughness).toBe(4);
    expect(ox?.damageMarked).toBe(2);
    expect(spec.battlefield.some((permanent) => permanent.name === 'Lab Servo')).toBe(false);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Collective Unconscious: draws two cards for your two creatures', () => {
    const { scenario } = runScenarioWith(
      'unconscious-viewer-draw-for-your-creatures',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Collective Unconscious');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    expect(p1.hand).toHaveLength(2);
    expect(p1.life).toBe(40);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Camaraderie: gains 2 life, draws two, pumps only your creatures', () => {
    const { scenario } = runScenarioWith('camaraderie-viewer-life-draw-and-pump', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Camaraderie');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    const spec = scenario.engine.spectatorState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    expect(p1.life).toBe(42);
    expect(p1.hand).toHaveLength(2);
    const yours = spec.battlefield.filter((permanent) => permanent.controller === 'P1');
    const theirs = spec.battlefield.filter((permanent) => permanent.controller === 'P2');
    expect(yours.find((permanent) => permanent.name === 'Lab Ox')?.power).toBe(5);
    expect(yours.find((permanent) => permanent.name === 'Lab Servo')?.power).toBe(2);
    expect(theirs.find((permanent) => permanent.name === 'Lab Ox')?.power).toBe(4);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Shamanic Revelation: draws two and gains 4 life for power 4', () => {
    const { scenario } = runScenarioWith(
      'revelation-viewer-draw-and-life-for-power-four',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Shamanic Revelation');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    expect(p1.hand).toHaveLength(2);
    expect(p1.life).toBe(44);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Flayed One: mills three from your library and has lifelink', () => {
    const { scenario } = runScenarioWith('flayed-viewer-etb-mill-three-lifelink', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Flayed One');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    const spec = scenario.engine.spectatorState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const p2 = state.players.find((player) => player.id === 'P2')!;
    const flayed = spec.battlefield.find((permanent) => permanent.name === 'Flayed One');
    expect(flayed?.power).toBe(4);
    expect(flayed?.toughness).toBe(1);
    expect(flayed?.keywords).toContain('lifelink');
    expect(p1.graveyard).toHaveLength(3);
    expect(p2.graveyard).toHaveLength(0);
    expect(state.eventLog.some((event) => event.type === 'mill')).toBe(true);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Night Scythe: creates a Necron Warrior token', () => {
    const { scenario } = runScenarioWith('scythe-viewer-etb-necron-warrior', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Night Scythe');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    expect(state.battlefield.some((permanent) => permanent.name === 'Night Scythe')).toBe(true);
    const warrior = state.battlefield.find((permanent) => permanent.name === 'Necron Warrior');
    expect(warrior).toBeDefined();
    expect(
      state.eventLog.some(
        (event) => event.type === 'tokenCreated' && event.payload['name'] === warrior?.name,
      ),
    ).toBe(true);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Game Trail: revealing a Forest enters untapped', () => {
    const { scenario } = runScenarioWith('trail-viewer-reveal-enters-untapped', (request, sc) => {
      const reveal = request.legalActions.find((action) =>
        action.description.includes('enters untapped'),
      );
      if (reveal !== undefined) return { actionId: reveal.id };
      const play = chooseWithTarget(request, sc, 'Game Trail');
      if (play !== null) return play;
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const trail = state.battlefield.find((permanent) => permanent.name === 'Game Trail');
    expect(trail).toBeDefined();
    expect(trail?.tapped).toBe(false);
    expect(p1.hand.map((card) => card.name)).toContain('Forest');
    expect(state.eventLog.some((event) => event.type === 'revealCard')).toBe(true);
  });

  it('Fortified Village: revealing a Plains enters untapped', () => {
    const { scenario } = runScenarioWith('village-viewer-reveal-enters-untapped', (request, sc) => {
      const reveal = request.legalActions.find((action) =>
        action.description.includes('enters untapped'),
      );
      if (reveal !== undefined) return { actionId: reveal.id };
      const play = chooseWithTarget(request, sc, 'Fortified Village');
      if (play !== null) return play;
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const village = state.battlefield.find((permanent) => permanent.name === 'Fortified Village');
    expect(village).toBeDefined();
    expect(village?.tapped).toBe(false);
    expect(p1.hand.map((card) => card.name)).toContain('Plains');
    expect(state.eventLog.some((event) => event.type === 'revealCard')).toBe(true);
  });

  it('Shineshadow Snarl: revealing a Swamp enters untapped', () => {
    const { scenario } = runScenarioWith('snarl-viewer-reveal-enters-untapped', (request, sc) => {
      const reveal = request.legalActions.find((action) =>
        action.description.includes('enters untapped'),
      );
      if (reveal !== undefined) return { actionId: reveal.id };
      const play = chooseWithTarget(request, sc, 'Shineshadow Snarl');
      if (play !== null) return play;
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const snarl = state.battlefield.find((permanent) => permanent.name === 'Shineshadow Snarl');
    expect(snarl).toBeDefined();
    expect(snarl?.tapped).toBe(false);
    expect(p1.hand.map((card) => card.name)).toContain('Swamp');
    expect(state.eventLog.some((event) => event.type === 'revealCard')).toBe(true);
  });

  it('Magmaquake: X=2 damages ground creatures and spares flying', () => {
    const { scenario } = runScenarioWith('quake-viewer-x-damage-spares-flying', (request, sc) => {
      const quake = request.legalActions.find(
        (action) => action.description.includes('Magmaquake') && action.data?.['x'] === 2,
      );
      if (quake !== undefined) return { actionId: quake.id };
      const fallback = chooseWithTarget(request, sc, 'Magmaquake');
      if (fallback !== null) return fallback;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const ox = spec.battlefield.find((permanent) => permanent.name === 'Lab Ox');
    const bird = spec.battlefield.find((permanent) => permanent.name === 'Lab Bird');
    expect(ox?.damageMarked).toBe(2);
    expect(bird?.damageMarked).toBe(0);
    expect(spec.battlefield.some((permanent) => permanent.name === 'Lab Servo')).toBe(false);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it("Hunter's Prowess: Lab Ox becomes 7/7 with trample", () => {
    const { scenario } = runScenarioWith('prowess-viewer-pump-and-trample', (request, sc) => {
      const cast = chooseWithTarget(request, sc, "Hunter's Prowess", 'Lab Ox');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const ox = spec.battlefield.find((permanent) => permanent.name === 'Lab Ox');
    expect(ox?.power).toBe(7);
    expect(ox?.toughness).toBe(7);
    expect(ox?.keywords).toContain('trample');
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Royal Warden: ETB creates two tapped Necron Warriors', () => {
    const { scenario } = runScenarioWith('warden-viewer-etb-two-tapped-warriors', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Royal Warden');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    const warriors = state.battlefield.filter((permanent) => permanent.name === 'Necron Warrior');
    expect(state.battlefield.some((permanent) => permanent.name === 'Royal Warden')).toBe(true);
    expect(warriors).toHaveLength(2);
    expect(warriors.every((token) => token.tapped)).toBe(true);
    expect(
      state.eventLog.filter(
        (event) => event.type === 'tokenCreated' && event.payload['name'] === 'Necron Warrior',
      ),
    ).toHaveLength(2);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Provoke the Trolls: Lab Ox takes 3 and becomes 9/4', () => {
    const { scenario } = runScenarioWith('provoke-viewer-damage-then-pump', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Provoke the Trolls', 'Lab Ox');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const ox = spec.battlefield.find((permanent) => permanent.name === 'Lab Ox');
    expect(ox?.power).toBe(9);
    expect(ox?.toughness).toBe(4);
    expect(ox?.damageMarked).toBe(3);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Hoard-Smelter Dragon: destroys Wrong-MV Artifact and becomes 8/5', () => {
    const { scenario } = runScenarioWith(
      'smelter-viewer-destroy-artifact-and-pump',
      (request, sc) => {
        const activate = request.legalActions.find(
          (action) =>
            action.type === 'activateAbility' && action.description.includes('Hoard-Smelter'),
        );
        if (activate !== undefined) {
          const names = objectNames(sc);
          const slots =
            (
              activate.interaction as
                { targetSlots?: Array<{ slot: number; options: string[] }> } | undefined
            )?.targetSlots ?? [];
          const slot = slots[0];
          if (slot !== undefined) {
            const artifact = slot.options.find((id) => names.get(id) === 'Wrong-MV Artifact');
            if (artifact !== undefined) {
              return { actionId: activate.id, targets: [{ slot: slot.slot, choice: artifact }] };
            }
          }
          return { actionId: activate.id };
        }
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const dragon = spec.battlefield.find((permanent) => permanent.name === 'Hoard-Smelter Dragon');
    expect(dragon?.power).toBe(8);
    expect(dragon?.toughness).toBe(5);
    expect(spec.battlefield.some((permanent) => permanent.name === 'Wrong-MV Artifact')).toBe(
      false,
    );
  });

  it('Loaming Shaman: shuffles P2 Lab Ox from the graveyard into the library', () => {
    const { scenario } = runScenarioWith(
      'loaming-viewer-shuffle-chosen-graveyard-card',
      (request, sc) => {
        const gy = request.legalActions.find((action) => action.description.includes('Lab Ox'));
        if (gy !== undefined) return { actionId: gy.id };
        const playerTarget = chooseWithTarget(request, sc, 'Loaming', 'P2');
        if (playerTarget !== null) return playerTarget;
        const cast = chooseWithTarget(request, sc, 'Loaming Shaman');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const p2 = state.players.find((player) => player.id === 'P2')!;
    expect(state.battlefield.some((permanent) => permanent.name === 'Loaming Shaman')).toBe(true);
    expect(p2.graveyard.map((card) => card.name)).not.toContain('Lab Ox');
    expect(p2.library.map((card) => card.name)).toContain('Lab Ox');
    expect(state.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
  });

  it('Chronomancer: sacrifices Lab Servo and draws Eligible Talisman', () => {
    const { scenario } = runScenarioWith('chrono-viewer-sac-artifact-draw', (request, sc) => {
      const activate = request.legalActions.find(
        (action) =>
          action.type === 'activateAbility' && action.description.includes('Chronomancer'),
      );
      if (activate !== undefined) {
        const names = objectNames(sc);
        const slots =
          (
            activate.interaction as
              { targetSlots?: Array<{ slot: number; options: string[] }> } | undefined
          )?.targetSlots ?? [];
        const slot = slots[0];
        if (slot !== undefined) {
          const servo = slot.options.find((id) => names.get(id) === 'Lab Servo');
          if (servo !== undefined) {
            return { actionId: activate.id, targets: [{ slot: slot.slot, choice: servo }] };
          }
        }
        return { actionId: activate.id };
      }
      const sac = request.legalActions.find((action) => action.description.includes('Lab Servo'));
      if (sac !== undefined) return { actionId: sac.id };
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    expect(state.battlefield.some((permanent) => permanent.name === 'Chronomancer')).toBe(true);
    expect(state.battlefield.some((permanent) => permanent.name === 'Lab Servo')).toBe(false);
    expect(p1.hand.map((card) => card.name)).toContain('Eligible Talisman');
  });

  it('Akoum Hellkite: playing a Mountain deals 2 to P2', () => {
    const { scenario } = runScenarioWith('akoum-viewer-mountain-landfall-two', (request, sc) => {
      const landfall = chooseWithTarget(request, sc, 'Akoum', 'P2');
      if (landfall !== null) return landfall;
      const play = chooseWithTarget(request, sc, 'Mountain');
      if (play !== null) return play;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const p2 = spec.seats.find((seat) => seat.seat === 'P2');
    expect(p2?.life).toBe(38);
    expect(spec.battlefield.some((permanent) => permanent.name === 'Mountain')).toBe(true);
  });

  it('Dawn of Hope: activation makes a lifelink Soldier', () => {
    const { scenario } = runScenarioWith('dawn-viewer-make-lifelink-soldier', (request) => {
      const activate = request.legalActions.find(
        (action) => action.type === 'activateAbility' && action.description.includes('Dawn'),
      );
      if (activate !== undefined) return { actionId: activate.id };
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const soldier = spec.battlefield.find((permanent) => permanent.name === 'Soldier');
    expect(soldier).toBeDefined();
    expect(soldier?.power).toBe(1);
    expect(soldier?.toughness).toBe(1);
    expect(soldier?.keywords).toContain('lifelink');
  });

  it('Rootborn Defenses: Lab Ox gains indestructible without a token to copy', () => {
    const { scenario } = runScenarioWith(
      'rootborn-viewer-indestructible-no-token',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Rootborn Defenses');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const ox = spec.battlefield.find((permanent) => permanent.name === 'Lab Ox');
    expect(ox?.keywords).toContain('indestructible');
    expect(spec.battlefield.filter((permanent) => permanent.name === 'Lab Ox')).toHaveLength(1);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Trostani Discordant: ETB two anthem-pumped lifelink Soldiers', () => {
    const { scenario } = runScenarioWith(
      'trostani-viewer-etb-two-lifelink-soldiers',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Trostani Discordant');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const soldiers = spec.battlefield.filter((permanent) => permanent.name === 'Soldier');
    expect(spec.battlefield.some((permanent) => permanent.name === 'Trostani Discordant')).toBe(
      true,
    );
    expect(soldiers).toHaveLength(2);
    expect(soldiers.every((permanent) => permanent.power === 2 && permanent.toughness === 2)).toBe(
      true,
    );
    expect(soldiers.every((permanent) => permanent.keywords.includes('lifelink'))).toBe(true);
  });

  it('Felidar Retreat: playing a Forest makes a Cat Beast', () => {
    const { scenario } = runScenarioWith('felidar-viewer-landfall-cat-beast', (request, sc) => {
      const cat = request.legalActions.find((action) => /Beast|Cat/.test(action.description));
      if (cat !== undefined) return { actionId: cat.id };
      const play = chooseWithTarget(request, sc, 'Forest');
      if (play !== null) return play;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const beast = spec.battlefield.find((permanent) => permanent.name === 'Cat Beast');
    expect(beast?.power).toBe(2);
    expect(beast?.toughness).toBe(2);
    expect(spec.battlefield.some((permanent) => permanent.name === 'Forest')).toBe(true);
  });

  it('Hornet Nest: 2 damage makes two flying deathtouch Insects and the Nest dies', () => {
    const { scenario } = runScenarioWith('nest-viewer-damage-makes-insects', (request, sc) => {
      const shock = chooseWithTarget(request, sc, 'Lab Shock', 'Hornet Nest');
      if (shock !== null) return shock;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const insects = spec.battlefield.filter((permanent) => permanent.name === 'Insect');
    expect(spec.battlefield.some((permanent) => permanent.name === 'Hornet Nest')).toBe(false);
    expect(insects).toHaveLength(2);
    expect(
      insects.every(
        (permanent) =>
          permanent.keywords.includes('flying') && permanent.keywords.includes('deathtouch'),
      ),
    ).toBe(true);
  });

  it('Slate of Ancestry: discards two and draws two for your creatures', () => {
    const { scenario } = runScenarioWith(
      'slate-viewer-discard-and-draw-for-creatures',
      (request) => {
        const discard = request.legalActions.find((action) =>
          action.description.toLowerCase().includes('discard'),
        );
        if (discard !== undefined) return { actionId: discard.id };
        const activate = request.legalActions.find(
          (action) =>
            action.type === 'activateAbility' && action.description.includes('Slate of Ancestry'),
        );
        if (activate !== undefined) return { actionId: activate.id };
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    expect(p1.hand).toHaveLength(2);
    expect(p1.graveyard.map((card) => card.name).sort()).toEqual([
      'Eligible Signet',
      'Eligible Talisman',
    ]);
    expect(
      state.battlefield.find((permanent) => permanent.name === 'Slate of Ancestry')?.tapped,
    ).toBe(true);
  });

  it('Canoptek Scarab Swarm: exiles P2 graveyard and makes two flying Insects', () => {
    const { scenario } = runScenarioWith(
      'scarab-viewer-exile-graveyard-make-insects',
      (request, sc) => {
        const etb = chooseWithTarget(request, sc, 'Canoptek', 'P2');
        if (etb !== null) return etb;
        const cast = chooseWithTarget(request, sc, 'Canoptek Scarab Swarm');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const state = scenario.engine.getState();
    const p2 = state.players.find((player) => player.id === 'P2')!;
    const insects = spec.battlefield.filter((permanent) => permanent.name === 'Insect');
    expect(spec.battlefield.some((permanent) => permanent.name === 'Canoptek Scarab Swarm')).toBe(
      true,
    );
    expect(p2.graveyard).toHaveLength(0);
    expect(state.exile).toHaveLength(3);
    expect(insects).toHaveLength(2);
    expect(insects.every((permanent) => permanent.keywords.includes('flying'))).toBe(true);
    expect(insects.every((permanent) => !permanent.keywords.includes('deathtouch'))).toBe(true);
  });

  it('Great Oak Guardian: P2 Lab Ox becomes 6/6 and untaps; Oak stays 4/5', () => {
    const { scenario } = runScenarioWith(
      'oak-viewer-pump-and-untap-target-player',
      (request, sc) => {
        const etb = chooseWithTarget(request, sc, 'Great Oak', 'P2');
        if (etb !== null) return etb;
        const cast = chooseWithTarget(request, sc, 'Great Oak Guardian');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const ox = spec.battlefield.find((permanent) => permanent.name === 'Lab Ox');
    const oak = spec.battlefield.find((permanent) => permanent.name === 'Great Oak Guardian');
    expect(ox?.power).toBe(6);
    expect(ox?.toughness).toBe(6);
    expect(ox?.tapped).toBe(false);
    expect(oak?.power).toBe(4);
    expect(oak?.toughness).toBe(5);
  });

  it('Frostboil Snarl: revealing an Island enters untapped', () => {
    const { scenario } = runScenarioWith(
      'frostboil-viewer-reveal-enters-untapped',
      (request, sc) => {
        const reveal = request.legalActions.find((action) =>
          action.description.includes('enters untapped'),
        );
        if (reveal !== undefined) return { actionId: reveal.id };
        const play = chooseWithTarget(request, sc, 'Frostboil Snarl');
        if (play !== null) return play;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const snarl = state.battlefield.find((permanent) => permanent.name === 'Frostboil Snarl');
    expect(snarl).toBeDefined();
    expect(snarl?.tapped).toBe(false);
    expect(p1.hand.map((card) => card.name)).toContain('Island');
    expect(state.eventLog.some((event) => event.type === 'revealCard')).toBe(true);
  });

  it('Vineglimmer Snarl: revealing a Forest enters untapped', () => {
    const { scenario } = runScenarioWith(
      'vineglimmer-viewer-reveal-enters-untapped',
      (request, sc) => {
        const reveal = request.legalActions.find((action) =>
          action.description.includes('enters untapped'),
        );
        if (reveal !== undefined) return { actionId: reveal.id };
        const play = chooseWithTarget(request, sc, 'Vineglimmer Snarl');
        if (play !== null) return play;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const snarl = state.battlefield.find((permanent) => permanent.name === 'Vineglimmer Snarl');
    expect(snarl).toBeDefined();
    expect(snarl?.tapped).toBe(false);
    expect(p1.hand.map((card) => card.name)).toContain('Forest');
    expect(state.eventLog.some((event) => event.type === 'revealCard')).toBe(true);
  });

  it('Stroke of Midnight: destroys Lab Ox and P2 gets a 1/1 Human', () => {
    const { scenario } = runScenarioWith(
      'stroke-viewer-destroy-nonland-make-human',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Stroke of Midnight', 'Lab Ox');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const human = spec.battlefield.find((permanent) => permanent.name === 'Human');
    expect(spec.battlefield.some((permanent) => permanent.name === 'Lab Ox')).toBe(false);
    expect(human?.controller).toBe('P2');
    expect(human?.power).toBe(1);
    expect(human?.toughness).toBe(1);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Generous Gift: destroys Lab Ox and P2 gets a 3/3 Elephant', () => {
    const { scenario } = runScenarioWith('gift-viewer-destroy-and-make-elephant', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Generous Gift', 'Lab Ox');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const elephant = spec.battlefield.find((permanent) => permanent.name === 'Elephant');
    expect(spec.battlefield.some((permanent) => permanent.name === 'Lab Ox')).toBe(false);
    expect(elephant?.controller).toBe('P2');
    expect(elephant?.power).toBe(3);
    expect(elephant?.toughness).toBe(3);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Boros Garrison: bouncing Forest leaves Garrison tapped on the battlefield', () => {
    const { scenario } = runScenarioWith(
      'garrison-viewer-bounce-forest-enters-tapped',
      (request, sc) => {
        const bounceForest = request.legalActions.find((action) =>
          /Return Forest/i.test(action.description),
        );
        if (bounceForest !== undefined) return { actionId: bounceForest.id };
        const play = chooseWithTarget(request, sc, 'Boros Garrison');
        if (play !== null) return play;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const garrison = state.battlefield.find((permanent) => permanent.name === 'Boros Garrison');
    expect(garrison).toBeDefined();
    expect(garrison?.tapped).toBe(true);
    expect(p1.hand.map((card) => card.name)).toContain('Forest');
    expect(state.battlefield.some((permanent) => permanent.name === 'Forest')).toBe(false);
  });

  it('Orzhov Basilica: bouncing Forest leaves Basilica tapped on the battlefield', () => {
    const { scenario } = runScenarioWith(
      'basilica-viewer-bounce-forest-enters-tapped',
      (request, sc) => {
        const bounceForest = request.legalActions.find((action) =>
          /Return Forest/i.test(action.description),
        );
        if (bounceForest !== undefined) return { actionId: bounceForest.id };
        const play = chooseWithTarget(request, sc, 'Orzhov Basilica');
        if (play !== null) return play;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const basilica = state.battlefield.find((permanent) => permanent.name === 'Orzhov Basilica');
    expect(basilica).toBeDefined();
    expect(basilica?.tapped).toBe(true);
    expect(p1.hand.map((card) => card.name)).toContain('Forest');
    expect(state.battlefield.some((permanent) => permanent.name === 'Forest')).toBe(false);
  });

  it('Pia and Kiran Nalaar: ETB two 1/1 flying Thopters', () => {
    const { scenario } = runScenarioWith('pia-kiran-viewer-etb-two-thopters', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Pia and Kiran Nalaar');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const thopters = spec.battlefield.filter((permanent) => permanent.name === 'Thopter');
    expect(spec.battlefield.some((permanent) => permanent.name === 'Pia and Kiran Nalaar')).toBe(
      true,
    );
    expect(thopters).toHaveLength(2);
    expect(thopters.every((permanent) => permanent.power === 1 && permanent.toughness === 1)).toBe(
      true,
    );
    expect(thopters.every((permanent) => permanent.keywords.includes('flying'))).toBe(true);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Crackling Doom: P2 sacs Lab Ox and each opponent loses 2 life', () => {
    const { scenario } = runScenarioWith(
      'crackling-viewer-damage-and-greatest-sacrifice',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Crackling Doom');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const p2 = state.players.find((player) => player.id === 'P2')!;
    const p3 = state.players.find((player) => player.id === 'P3')!;
    expect(spec.battlefield.some((permanent) => permanent.name === 'Lab Ox')).toBe(false);
    expect(p1.life).toBe(40);
    expect(p2.life).toBe(38);
    expect(p3.life).toBe(38);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Rakdos Carnarium: bouncing Forest leaves Carnarium tapped on the battlefield', () => {
    const { scenario } = runScenarioWith(
      'carnarium-viewer-bounce-forest-enters-tapped',
      (request, sc) => {
        const bounceForest = request.legalActions.find((action) =>
          /Return Forest/i.test(action.description),
        );
        if (bounceForest !== undefined) return { actionId: bounceForest.id };
        const play = chooseWithTarget(request, sc, 'Rakdos Carnarium');
        if (play !== null) return play;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const carnarium = state.battlefield.find((permanent) => permanent.name === 'Rakdos Carnarium');
    expect(carnarium).toBeDefined();
    expect(carnarium?.tapped).toBe(true);
    expect(p1.hand.map((card) => card.name)).toContain('Forest');
    expect(state.battlefield.some((permanent) => permanent.name === 'Forest')).toBe(false);
  });

  it('Whirler Rogue: ETB two 1/1 flying Thopters', () => {
    const { scenario } = runScenarioWith('whirler-viewer-etb-two-thopters', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Cast Whirler Rogue');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const thopters = spec.battlefield.filter((permanent) => permanent.name === 'Thopter');
    expect(spec.battlefield.some((permanent) => permanent.name === 'Whirler Rogue')).toBe(true);
    expect(thopters).toHaveLength(2);
    expect(thopters.every((permanent) => permanent.power === 1 && permanent.toughness === 1)).toBe(
      true,
    );
    expect(thopters.every((permanent) => permanent.keywords.includes('flying'))).toBe(true);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Reckless Fireweaver: artifact ETB deals 1 to each opponent', () => {
    const { scenario } = runScenarioWith(
      'weaver-viewer-artifact-etb-pings-opponents',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Eligible Talisman');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const p2 = state.players.find((player) => player.id === 'P2')!;
    const p3 = state.players.find((player) => player.id === 'P3')!;
    expect(spec.battlefield.some((permanent) => permanent.name === 'Eligible Talisman')).toBe(true);
    expect(spec.battlefield.some((permanent) => permanent.name === 'Reckless Fireweaver')).toBe(
      true,
    );
    expect(p1.life).toBe(40);
    expect(p2.life).toBe(39);
    expect(p3.life).toBe(39);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Spit Flame: 4 damage destroys Lab Ox', () => {
    const { scenario } = runScenarioWith('spit-viewer-four-damage-to-ox', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Spit Flame', 'Lab Ox');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    expect(spec.battlefield.some((permanent) => permanent.name === 'Lab Ox')).toBe(false);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Sai, Master Thopterist: casting an artifact makes a flying Thopter', () => {
    const { scenario } = runScenarioWith(
      'sai-viewer-cast-artifact-makes-thopter',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Eligible Talisman');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const thopter = spec.battlefield.find((permanent) => permanent.name === 'Thopter');
    expect(spec.battlefield.some((permanent) => permanent.name === 'Eligible Talisman')).toBe(true);
    expect(spec.battlefield.some((permanent) => permanent.name === 'Sai, Master Thopterist')).toBe(
      true,
    );
    expect(thopter).toBeDefined();
    expect(thopter?.power).toBe(1);
    expect(thopter?.toughness).toBe(1);
    expect(thopter?.keywords).toContain('flying');
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Secret Rendezvous: you and P2 each draw three nonlands', () => {
    const { scenario } = runScenarioWith(
      'rendezvous-viewer-you-and-opponent-draw-three',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Secret Rendezvous', 'P2');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const p2 = state.players.find((player) => player.id === 'P2')!;
    const p3 = state.players.find((player) => player.id === 'P3')!;
    expect(p1.hand).toHaveLength(3);
    expect(p1.hand.every((card) => !card.typeLine.includes('Land'))).toBe(true);
    expect(p2.hand).toHaveLength(3);
    expect(p2.hand.every((card) => !card.typeLine.includes('Land'))).toBe(true);
    expect(p3.hand).toHaveLength(0);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Demanding Dragon: 5 damage when P2 has no creature to sacrifice', () => {
    const { scenario } = runScenarioWith(
      'demanding-viewer-five-damage-no-creature',
      (request, sc) => {
        const etb = chooseWithTarget(request, sc, 'Demanding', 'P2');
        if (etb !== null) return etb;
        const cast = chooseWithTarget(request, sc, 'Cast Demanding Dragon');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const p2 = spec.seats.find((seat) => seat.seat === 'P2');
    const p3 = spec.seats.find((seat) => seat.seat === 'P3');
    expect(spec.battlefield.some((permanent) => permanent.name === 'Demanding Dragon')).toBe(true);
    expect(p1.life).toBe(40);
    expect(p2?.life).toBe(35);
    expect(p3?.life).toBe(40);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Cryptothrall: other artifact creatures you control have hexproof', () => {
    const { scenario } = runScenarioWith(
      'cryptothrall-viewer-hexproof-other-artifact-creatures',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Cast Cryptothrall');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const yours = spec.battlefield.find(
      (permanent) => permanent.name === 'Lab Servo' && permanent.controller === 'P1',
    );
    const ox = spec.battlefield.find((permanent) => permanent.name === 'Lab Ox');
    const theirs = spec.battlefield.find(
      (permanent) => permanent.name === 'Lab Servo' && permanent.controller === 'P2',
    );
    const self = spec.battlefield.find((permanent) => permanent.name === 'Cryptothrall');
    expect(yours?.keywords).toContain('hexproof');
    expect(ox?.keywords ?? []).not.toContain('hexproof');
    expect(theirs?.keywords ?? []).not.toContain('hexproof');
    expect(self?.keywords ?? []).not.toContain('hexproof');
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Boros Charm: 4 damage to P2; double strike is not offered', () => {
    const { scenario } = runScenarioWith(
      'boros-charm-viewer-four-damage-to-player',
      (request, sc) => {
        const damage = chooseWithTarget(request, sc, 'Deal 4 damage', 'P2');
        if (damage !== null) return damage;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const p2 = spec.seats.find((seat) => seat.seat === 'P2');
    const p3 = spec.seats.find((seat) => seat.seat === 'P3');
    expect(p1.life).toBe(40);
    expect(p2?.life).toBe(36);
    expect(p3?.life).toBe(40);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Rakdos Charm: destroy the artifact, not Lab Ox', () => {
    const { scenario } = runScenarioWith('rakdos-charm-viewer-destroy-artifact', (request, sc) => {
      const destroy = chooseWithTarget(request, sc, 'Destroy target artifact', 'Wrong-MV Artifact');
      if (destroy !== null) return destroy;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    expect(spec.battlefield.some((permanent) => permanent.name === 'Wrong-MV Artifact')).toBe(
      false,
    );
    expect(spec.battlefield.some((permanent) => permanent.name === 'Lab Ox')).toBe(true);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Steel Hellkite: {2} pumps +1/+0 until end of turn', () => {
    const { scenario } = runScenarioWith('hellkite-viewer-plus-one-power-until-eot', (request) => {
      const pump = request.legalActions.find((action) => action.description.includes('+1/+0'));
      if (pump !== undefined) return { actionId: pump.id };
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const hellkite = spec.battlefield.find((permanent) => permanent.name === 'Steel Hellkite');
    expect(hellkite?.power).toBe(6);
    expect(hellkite?.toughness).toBe(5);
  });

  it('Rogue Refiner: ETB draws a nonland and grants two energy', () => {
    const { scenario } = runScenarioWith('refiner-viewer-etb-draw-two-energy', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Cast Rogue Refiner');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const p2 = state.players.find((player) => player.id === 'P2')!;
    const you = spec.seats.find((seat) => seat.seat === 'P1');
    expect(spec.battlefield.some((permanent) => permanent.name === 'Rogue Refiner')).toBe(true);
    expect(p1.hand).toHaveLength(1);
    expect(p1.hand.every((card) => !card.typeLine.includes('Land'))).toBe(true);
    expect(p2.hand).toHaveLength(0);
    expect(you?.energy).toBe(2);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Whirler Virtuoso: three energy makes a flying Thopter', () => {
    const { scenario } = runScenarioWith('virtuoso-viewer-energy-makes-thopter', (request, sc) => {
      const thopter = request.legalActions.find((action) => /thopter/i.test(action.description));
      if (thopter !== undefined) return { actionId: thopter.id };
      const cast = chooseWithTarget(request, sc, 'Cast Whirler Virtuoso');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const you = spec.seats.find((seat) => seat.seat === 'P1');
    const token = spec.battlefield.find((permanent) => permanent.name === 'Thopter');
    expect(spec.battlefield.some((permanent) => permanent.name === 'Whirler Virtuoso')).toBe(true);
    expect(token).toBeDefined();
    expect(token?.power).toBe(1);
    expect(token?.toughness).toBe(1);
    expect(token?.keywords).toContain('flying');
    expect(you?.energy).toBe(0);
  });

  it('Ajani, Caller of the Pride: +1 puts a counter on Lab Ox', () => {
    const { scenario } = runScenarioWith('ajani-viewer-plus-one-counter', (request, sc) => {
      const plus = request.legalActions.find((action) =>
        action.description.includes('+1: Put a +1/+1 counter'),
      );
      if (plus !== undefined) {
        const names = objectNames(sc);
        const slot = plus.targets?.[0];
        const ox = slot?.options.find((id) => names.get(id) === 'Lab Ox');
        if (slot !== undefined && ox !== undefined) {
          return { actionId: plus.id, targets: [{ slot: slot.slot, choice: ox }] };
        }
        return { actionId: plus.id };
      }
      const targeted = chooseWithTarget(request, sc, 'Ajani', 'Lab Ox');
      if (targeted !== null) return targeted;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const ox = spec.battlefield.find((permanent) => permanent.name === 'Lab Ox');
    const ajani = spec.battlefield.find(
      (permanent) => permanent.name === 'Ajani, Caller of the Pride',
    );
    expect(ox?.power).toBe(5);
    expect(ox?.toughness).toBe(5);
    expect(ox?.keywords ?? []).not.toContain('flying');
    expect(ox?.keywords ?? []).not.toContain('double strike');
    expect(ajani?.counters['loyalty']).toBe(5);
  });

  it('Terror of the Peaks: entering Two-Mana Bear deals 2 to P2', () => {
    const { scenario } = runScenarioWith('terror-viewer-etb-damage-to-player', (request, sc) => {
      const damage = chooseWithTarget(request, sc, 'Terror', 'P2');
      if (damage !== null) return damage;
      const cast = chooseWithTarget(request, sc, 'Cast Two-Mana Bear');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const p2 = spec.seats.find((seat) => seat.seat === 'P2');
    const p3 = spec.seats.find((seat) => seat.seat === 'P3');
    expect(spec.battlefield.some((permanent) => permanent.name === 'Terror of the Peaks')).toBe(
      true,
    );
    expect(spec.battlefield.some((permanent) => permanent.name === 'Two-Mana Bear')).toBe(true);
    expect(p1.life).toBe(40);
    expect(p2?.life).toBe(38);
    expect(p3?.life).toBe(40);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Aetherwind Basker: pay one energy to become 8/8 until end of turn', () => {
    const { scenario } = runScenarioWith('basker-viewer-plus-one-until-eot', (request, sc) => {
      const pump = request.legalActions.find((action) => action.description.includes('+1/+1'));
      if (pump !== undefined) return { actionId: pump.id };
      const cast = chooseWithTarget(request, sc, 'Cast Aetherwind Basker');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const basker = spec.battlefield.find((permanent) => permanent.name === 'Aetherwind Basker');
    const you = spec.seats.find((seat) => seat.seat === 'P1');
    expect(basker?.power).toBe(8);
    expect(basker?.toughness).toBe(8);
    expect(basker?.keywords).toContain('trample');
    expect(you?.energy).toBe(0);
  });

  it('Zopandrel: normal activation exposes the indestructible counter as a keyword', () => {
    const { scenario } = runScenarioWith('zopandrel-viewer-indestructible-counter', (request) => {
      const activate = request.legalActions.find((action) =>
        action.description.includes('indestructible counter'),
      );
      if (activate !== undefined) return { actionId: activate.id };
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const zopandrel = spec.battlefield.find(
      (permanent) => permanent.name === 'Zopandrel, Hunger Dominus',
    );
    expect(zopandrel?.counters['indestructible']).toBe(1);
    expect(zopandrel?.keywords).toContain('indestructible');
    expect(spec.battlefield.some((permanent) => permanent.name === 'Two-Mana Bear')).toBe(false);
    expect(spec.battlefield.some((permanent) => permanent.name === 'Lab Shaman')).toBe(false);
  });

  it.each([0, 2] as const)(
    'Arcane Denial: normal cast routes draw-%i at the immediately next upkeep',
    (drawCount) => {
      const { scenario } = runScenarioWith(
        `arcane-denial-viewer-draw-${drawCount === 0 ? 'zero' : 'two'}`,
        arcaneDenialChoice(drawCount),
      );
      const state = scenario.engine.getState();
      const p1 = state.players.find((player) => player.id === 'P1')!;
      const p4 = state.players.find((player) => player.id === 'P4')!;
      expect(state.turnNumber).toBe(2);
      expect(scenario.engine.spectatorState().activePlayer).toBe('P2');
      expect(p1.hand.map((card) => card.name)).toEqual(['Caster Secret Draw']);
      expect(p4.hand).toHaveLength(drawCount);
      expect(p4.hand.every((card) => card.name.startsWith('Target Secret'))).toBe(true);
      expect(p4.graveyard.map((card) => card.name)).toContain('Lab Pending Spell');
      expect(state.eventLog.filter((event) => event.type === 'draw')).toHaveLength(drawCount + 1);
    },
  );

  it('arcane-denial-prepared-scenario-deterministic-replay — reproduces state and events', () => {
    const first = runScenarioWith(
      'arcane-denial-viewer-draw-two',
      arcaneDenialChoice(2),
    ).scenario.engine.getState();
    const second = runScenarioWith(
      'arcane-denial-viewer-draw-two',
      arcaneDenialChoice(2),
    ).scenario.engine.getState();

    expect(structuredClone(second)).toEqual(structuredClone(first));
    expect(second.eventLog).toEqual(first.eventLog);
  });

  it.each(['pay', 'decline'] as const)(
    'smothering-tithe-prepared-scenarios-pay-decline — opponent draw %s path uses normal engine actions',
    (outcome) => {
      const { scenario } = runScenarioWith(
        `smothering-tithe-viewer-${outcome}`,
        smotheringTitheChoice(outcome),
      );
      const state = scenario.engine.getState();
      const p1 = state.players.find((player) => player.id === 'P1')!;
      const treasures = state.battlefield.filter(
        (permanent) => permanent.name === 'Treasure' && permanent.controllerId === 'P2',
      );
      expect(p1.hand.map((card) => card.name)).toEqual([
        `Tithe Secret ${outcome === 'pay' ? 'Pay' : 'Decline'}`,
      ]);
      expect(treasures).toHaveLength(outcome === 'pay' ? 0 : 1);
      expect(
        state.battlefield
          .filter((permanent) => permanent.name === 'Forest' && permanent.controllerId === 'P1')
          .filter((permanent) => permanent.tapped),
      ).toHaveLength(outcome === 'pay' ? 3 : 1);
      expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
      expect(state.eventLog.filter((event) => event.type === 'draw')).toHaveLength(1);
      expect(state.eventLog.some((event) => event.type === 'unlessPaid')).toBe(outcome === 'pay');
      expect(
        state.eventLog.some(
          (event) =>
            event.type === 'decision' &&
            event.payload['description'] === (outcome === 'pay' ? 'Pay {2}' : "Don't pay {2}"),
        ),
      ).toBe(true);
    },
  );

  it('smothering-tithe-prepared-scenario-deterministic-replay — reproduces state and events', () => {
    const run = () =>
      runScenarioWith(
        'smothering-tithe-viewer-decline',
        smotheringTitheChoice('decline'),
      ).scenario.engine.getState();
    const first = run();
    const second = run();
    expect(structuredClone(second)).toEqual(structuredClone(first));
    expect(second.eventLog).toEqual(first.eventLog);
  });

  it('fabled-passage-prepared-scenario — activates, searches privately, and untaps the bound fourth land', () => {
    const { scenario } = runScenarioWith(
      'fabled-passage-viewer-search-entry-untap',
      fabledPassageChoice,
    );
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const island = state.battlefield.find(
      (permanent) => permanent.controllerId === 'P1' && permanent.name === 'Island',
    );
    expect(p1.graveyard.map((card) => card.name)).toContain('Fabled Passage');
    expect(island?.tapped).toBe(false);
    expect(
      state.battlefield.filter(
        (permanent) => permanent.controllerId === 'P1' && permanent.typeLine.includes('Land'),
      ),
    ).toHaveLength(4);
    expect(state.eventLog.some((event) => event.type === 'activateAbility')).toBe(true);
    expect(
      state.eventLog.some(
        (event) => event.type === 'searchFound' && event.payload['name'] === 'Island',
      ),
    ).toBe(true);
    expect(state.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
    expect(JSON.stringify(scenario.engine.view('P2'))).not.toContain(
      'Fabled Private Library Secret',
    );
  });

  it('fabled-passage-prepared-scenario-deterministic-replay — reproduces state and events', () => {
    const run = () =>
      runScenarioWith(
        'fabled-passage-viewer-search-entry-untap',
        fabledPassageChoice,
      ).scenario.engine.getState();
    const first = run();
    const second = run();
    expect(structuredClone(second)).toEqual(structuredClone(first));
    expect(second.eventLog).toEqual(first.eventLog);
  });

  it('myriad-landscape-entry-scenario — normal land play applies the tapped replacement', () => {
    const { scenario } = runScenarioWith(
      'myriad-landscape-viewer-enters-tapped',
      myriadLandscapeEntryChoice,
    );
    const state = scenario.engine.getState();
    const landscape = state.battlefield.find(
      (permanent) => permanent.controllerId === 'P1' && permanent.name === 'Myriad Landscape',
    );
    expect(landscape?.tapped).toBe(true);
    expect(state.eventLog.some((event) => event.type === 'playLand')).toBe(true);
    expect(state.stack).toHaveLength(0);
  });

  it('myriad-landscape-search-scenario — pays, sacrifices, and finds a legal shared-type pair', () => {
    const { scenario } = runScenarioWith(
      'myriad-landscape-viewer-shared-type-search',
      myriadLandscapeSearchChoice,
    );
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const found = state.battlefield.filter(
      (permanent) =>
        permanent.controllerId === 'P1' &&
        ['Island', 'Myriad Shared Dual'].includes(permanent.name),
    );
    expect(p1.graveyard.map((card) => card.name)).toContain('Myriad Landscape');
    expect(found).toHaveLength(2);
    expect(found.every((permanent) => permanent.tapped)).toBe(true);
    expect(
      state.battlefield
        .filter((permanent) => permanent.controllerId === 'P1' && permanent.name === 'Forest')
        .filter((permanent) => permanent.tapped),
    ).toHaveLength(2);
    expect(state.eventLog.some((event) => event.type === 'activateAbility')).toBe(true);
    expect(state.eventLog.filter((event) => event.type === 'searchFound')).toHaveLength(2);
    expect(state.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
    expect(JSON.stringify(scenario.engine.view('P2'))).not.toContain(
      'Myriad Private Library Secret',
    );
  });

  it('myriad-landscape-mana-scenario — pays a normal spell cost with the colorless mana ability', () => {
    const { scenario } = runScenarioWith(
      'myriad-landscape-viewer-colorless-mana',
      myriadLandscapeManaChoice,
    );
    const state = scenario.engine.getState();
    const landscape = state.battlefield.find(
      (permanent) => permanent.controllerId === 'P1' && permanent.name === 'Myriad Landscape',
    );
    expect(landscape?.tapped).toBe(true);
    expect(state.battlefield.map((permanent) => permanent.name)).toContain('Myriad Mana Sink');
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('myriad-landscape-search-scenario-deterministic-replay — reproduces state and events', () => {
    const run = () =>
      runScenarioWith(
        'myriad-landscape-viewer-shared-type-search',
        myriadLandscapeSearchChoice,
      ).scenario.engine.getState();
    const first = run();
    const second = run();
    expect(structuredClone(second)).toEqual(structuredClone(first));
    expect(second.eventLog).toEqual(first.eventLog);
  });

  it('war-room-retained-action - returns a genuine P1 cast after the forced draw resolution', () => {
    const scenario = createCardTestScenario(
      'war-room-viewer-dynamic-life-activation',
      'war-room-retained-action',
    )!;
    const first = scenario.engine.advance();
    expect(first.kind).toBe('decision');
    if (first.kind !== 'decision') throw new Error('Missing activation request');
    scenario.engine.submit({
      requestId: first.request.requestId,
      ...warRoomDrawChoice(first.request),
    });
    const settled = scenario.engine.advance();
    expect(settled.kind).toBe('decision');
    if (settled.kind !== 'decision') throw new Error('Missing retained P1 request');
    expect(settled.request.decidingPlayer).toBe('P1');
    expect(
      settled.request.legalActions.some(
        (action) =>
          action.type === 'castSpell' &&
          action.description === 'Cast War Room Action Witness ({0})',
      ),
    ).toBe(true);
    const state = scenario.engine.getState();
    expect(state.players[0]!.life).toBe(37);
    expect(state.players[0]!.hand).toHaveLength(3);
    expect(state.stack).toHaveLength(0);
  });

  it('war-room-draw-scenario — pays three life for the three-color identity and draws exactly once', () => {
    let activated = false;
    const { scenario } = runScenarioWith(
      'war-room-viewer-dynamic-life-activation',
      (request, sc) => {
        const state = sc.engine.getState();
        const p1 = state.players.find((player) => player.id === 'P1')!;
        if (!activated) {
          assertWarRoomProjections(sc);
          expect(p1.life).toBe(40);
          expect(p1.hand.map((card) => card.name)).toEqual([
            'War Room Mana Sink',
            'War Room Action Witness',
          ]);
          const choice = warRoomDrawChoice(request);
          expect(request.legalActions.find((action) => action.id === choice.actionId)?.type).toBe(
            'activateAbility',
          );
          activated = true;
          return choice;
        }
        expect(request.decidingPlayer).toBe('P1');
        expect(p1.life).toBe(37);
        expect(p1.hand).toHaveLength(3);
        expect(state.stack).toHaveLength(0);
        expect(
          request.legalActions.some(
            (action) =>
              action.type === 'castSpell' &&
              action.description === 'Cast War Room Action Witness ({0})',
          ),
        ).toBe(true);
        const choice = warRoomDrawChoice(request);
        expect(request.legalActions.find((action) => action.id === choice.actionId)?.type).toBe(
          'pass',
        );
        return choice;
      },
    );
    expect(activated).toBe(true);
    assertWarRoomProjections(scenario);
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const lands = state.battlefield.filter(
      (permanent) => permanent.controllerId === 'P1' && permanent.typeLine.includes('Land'),
    );

    expect(p1.life).toBe(37);
    expect(lands.map((permanent) => permanent.name).sort()).toEqual([
      'Forest',
      'Forest',
      'Forest',
      'War Room',
    ]);
    expect(lands.every((permanent) => permanent.tapped)).toBe(true);
    // Hand 2 -> 3: the sink stays, and the only library card is drawn.
    expect(p1.hand.map((card) => card.name).sort()).toEqual([
      'Three Color Commander',
      'War Room Action Witness',
      'War Room Mana Sink',
    ]);
    expect(state.eventLog.some((event) => event.type === 'activateAbility')).toBe(true);
    expect(
      state.eventLog.filter((event) => event.type === 'draw' && event.actorSeat === 'P1'),
    ).toHaveLength(1);
    expect(
      state.eventLog.find((event) => event.type === 'draw' && event.actorSeat === 'P1')?.payload[
        'name'
      ],
    ).toBe('Three Color Commander');
    expect(state.stack).toHaveLength(0);
  });

  it('war-room-mana-scenario — pays a normal spell cost with the colorless mana ability', () => {
    let cast = false;
    const { scenario } = runScenarioWith('war-room-viewer-colorless-mana', (request, sc) => {
      const state = sc.engine.getState();
      const p1 = state.players.find((player) => player.id === 'P1')!;
      if (!cast) {
        assertWarRoomProjections(sc);
        expect(state.players).toHaveLength(4);
        expect(state.phase).toBe('precombatMain');
        expect(p1.life).toBe(40);
        expect(Object.values(p1.manaPool).every((amount) => amount === 0)).toBe(true);
        expect(p1.hand.map((card) => card.name)).toEqual(['War Room Mana Sink']);
        expect(state.battlefield.map((permanent) => permanent.name)).toEqual(['War Room']);
        expect(state.battlefield[0]?.tapped).toBe(false);
        cast = true;
      }
      return warRoomManaChoice(request);
    });
    expect(cast).toBe(true);
    assertWarRoomProjections(scenario);
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const warRoom = state.battlefield.find(
      (permanent) => permanent.controllerId === 'P1' && permanent.name === 'War Room',
    );

    expect(warRoom?.tapped).toBe(true);
    expect(p1.hand).toHaveLength(0);
    expect(Object.values(p1.manaPool).every((amount) => amount === 0)).toBe(true);
    expect(state.battlefield.map((permanent) => permanent.name)).toContain('War Room Mana Sink');
    expect(
      state.eventLog.some(
        (event) => event.type === 'castSpell' && event.payload['name'] === 'War Room Mana Sink',
      ),
    ).toBe(true);
    // The mana clause must not borrow the draw clause's evidence: no life is paid, nothing is drawn.
    expect(p1.life).toBe(40);
    expect(
      state.eventLog.filter((event) => event.type === 'draw' && event.actorSeat === 'P1'),
    ).toHaveLength(0);
    expect(state.stack).toHaveLength(0);
  });

  it('war-room-draw-scenario-deterministic-replay - reproduces state and events', () => {
    const run = () =>
      runScenarioWith(
        'war-room-viewer-dynamic-life-activation',
        warRoomDrawChoice,
      ).scenario.engine.getState();
    const first = run();
    const second = run();
    expect(structuredClone(second)).toEqual(structuredClone(first));
    expect(second.eventLog).toEqual(first.eventLog);
  });

  it('war-room-mana-scenario-deterministic-replay — reproduces state and events', () => {
    const run = () =>
      runScenarioWith(
        'war-room-viewer-colorless-mana',
        warRoomManaChoice,
      ).scenario.engine.getState();
    const first = run();
    const second = run();
    expect(structuredClone(second)).toEqual(structuredClone(first));
    expect(second.eventLog).toEqual(first.eventLog);
  });
});

describe('opponent graveyard viewer scenario', () => {
  it('offers public creature cards from both graveyards and resolves the opponent target', () => {
    let sawCast = false;
    const { scenario } = runScenarioWith('opponent-graveyard-viewer-reanimate', (request, sc) => {
      const choice = chooseWithTarget(request, sc, 'Cast Lab Reanimation', 'Lab Ox');
      if (choice === null) return passChoice(request);
      sawCast = true;
      const action = request.legalActions.find((candidate) => candidate.id === choice.actionId)!;
      expect(action.interaction?.kind).toBe('source');
      if (action.interaction?.kind === 'source') {
        const names = objectNames(sc);
        expect(
          action.interaction.targetSlots?.[0]?.options.map((id) => names.get(id)).sort(),
        ).toEqual(['Lab Ox', 'Lab Servo']);
      }
      const view = sc.engine.playerState('P1');
      expect(
        view.seats.find((seat) => seat.seat === 'P2')?.graveyard.map((card) => card.name),
      ).toEqual(['Eligible Signet', 'Lab Ox']);
      expect(
        view.seats.filter((seat) => seat.seat !== 'P1').every((seat) => seat.hand === null),
      ).toBe(true);
      return choice;
    });
    expect(sawCast).toBe(true);
    const state = scenario.engine.getState();
    expect(state.players.find((player) => player.id === 'P1')?.life).toBe(36);
    expect(
      state.players.find((player) => player.id === 'P2')?.graveyard.map((card) => card.name),
    ).toEqual(['Eligible Signet']);
    expect(state.battlefield.find((permanent) => permanent.name === 'Lab Ox')).toMatchObject({
      ownerId: 'P2',
      controllerId: 'P1',
    });
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });
});
