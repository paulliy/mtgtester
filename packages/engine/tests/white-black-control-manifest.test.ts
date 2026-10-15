import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}

interface VerificationManifest {
  cards: Record<
    string,
    {
      name: string;
      oracleSha256: string;
      implementationStatus: string;
      referenceAliases: string[];
      clauses: {
        oracleText: string;
        engineTestIds: string[];
        engineTestSource: string[];
        viewerScenarioIds: string[];
      }[];
      gameplayAiScenarioIds: string[];
    }
  >;
}

interface Requirements {
  evidenceSemantics: {
    statement: string;
    factoryReadyViewerScenarioIds: string[];
    futureViewerScenarioIdsAreRequirementsOnly: boolean;
  };
  cards: {
    oracleId: string;
    cardName: string;
    implementationStatus: string;
    requiredScenarioIds: { viewer: string | string[]; gameplayAi: string };
    remainingViewerRequirements?: string[];
    clauses: { requiredScenarioIds: { viewer?: string | string[] } }[];
  }[];
}

const pinned = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/white-black-control-oracle.json', 'utf8'),
) as PinnedFixture;
const manifest = JSON.parse(
  readFileSync('packages/server/fixtures/card-verification-manifest.json', 'utf8'),
) as VerificationManifest;
const requirements = JSON.parse(
  readFileSync('docs/plans/white-black-control-verification-requirements.json', 'utf8'),
) as Requirements;

const authoredNames = [
  'Breena, the Demagogue',
  "Duelist's Heritage",
  'Duress',
  'Thoughtseize',
  'Dark Confidant',
  'Rule of Law',
  'Deafening Silence',
  'Hymn to Tourach',
  'Bottomless Pit',
  'Necrogen Mists',
  'Hypnotic Specter',
  'Oppression',
  'Syphon Mind',
  "Geth's Grimoire",
  'Archfiend of Ifnir',
  'Archon of Emeria',
  'Authority of the Consuls',
  'Doorkeeper Thrull',
  'Hushbringer',
  'Karn, Argent Defender',
  'Painful Quandary',
  'Rankle, Master of Pranks',
  'Vicious Rumors',
  'Rest in Peace',
  'Stone of Erech',
  'Waste Not',
  'Whispers of Emrakul',
  'Tinybones Joins Up',
  'Tinybones, Trinket Thief',
  'Mother of Runes',
  'Rebuff the Wicked',
  'Reprieve',
  'Sejiri Shelter // Sejiri Glacier',
  'Planar Void',
  'The Haunt of Hightower',
  'Library of Leng',
  'Leyline of the Void',
  'Liliana of the Veil',
  'Liliana, Waker of the Dead',
  'Archon of Absolution',
  'Soul Snare',
  'Curse of Disturbance',
  'Promise of Loyalty',
  "Imp's Mischief",
  'Restoration Magic',
  'Reluctant Role Model',
  'Cloak of Confusion',
  "Bandit's Talent",
  "Tergrid, God of Fright // Tergrid's Lantern",
  'Aven Interrupter',
  "Bilbo's Gambit",
  "Dawn's Truce",
  'Perch Protection',
];

function canonical(value: unknown): string {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    }
    return input;
  };
  return JSON.stringify(ordered(value));
}

function fixtureAlias(name: string): string {
  return `oracle-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`;
}

describe('white-black-control authored-card verification manifest', () => {
  it('binds only the authored 53 to their complete pinned Oracle text and real engine test sources', () => {
    expect(requirements.evidenceSemantics.futureViewerScenarioIdsAreRequirementsOnly).toBe(true);
    expect(authoredNames).toHaveLength(53);

    for (const name of authoredNames) {
      const pin = pinned.cards.find(({ card }) => card.name === name);
      expect(pin, `missing wrapper pin for ${name}`).toBeDefined();
      const card = pin!.card;
      const entry = manifest.cards[card.oracleId];
      expect(entry, `missing manifest card ${name}`).toBeDefined();
      expect(createHash('sha256').update(canonical(card)).digest('hex'), name).toBe(pin!.sha256);
      expect(entry!.name).toBe(name);
      expect(entry!.oracleSha256).toBe(pin!.sha256);
      expect(entry!.implementationStatus).toBe('implemented-unreviewed');
      expect(entry!.referenceAliases).toEqual([fixtureAlias(name)]);
      expect(entry!.clauses.map(({ oracleText }) => oracleText)).toEqual([
        ...card.oracleText.split('\n'),
        ...(card.backFace?.oracleText.split('\n') ?? []),
      ]);
      expect(entry!.gameplayAiScenarioIds).toEqual([]);

      for (const clause of entry!.clauses) {
        expect(
          clause.engineTestIds.length,
          `${name}: ${clause.oracleText} test IDs`,
        ).toBeGreaterThan(0);
        expect(
          clause.engineTestSource.length,
          `${name}: ${clause.oracleText} sources`,
        ).toBeGreaterThan(0);
        for (const testId of clause.engineTestIds) {
          const source = testId.split('::')[0]!;
          expect(clause.engineTestSource).toContain(`packages/engine/tests/${source}`);
          expect(existsSync(`packages/engine/tests/${source}`), testId).toBe(true);
          const title = testId.slice(testId.indexOf('::') + 2);
          expect(
            readFileSync(`packages/engine/tests/${source}`, 'utf8').replace(/\\'/g, "'"),
            testId,
          ).toContain(title);
        }
      }
    }
  });

  it('records the 84 factory-ready viewer scenario declarations without claiming execution', () => {
    expect(requirements.evidenceSemantics.statement).toContain('registered scenario definitions');
    expect(requirements.evidenceSemantics.statement).toContain('not generated viewer outputs');
    const ready = [
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
      'archfiend-of-ifnir-viewer-cycle-counter',
      'waste-not-viewer-opponent-discard-payoffs',
      'whispers-of-emrakul-viewer-delirium-random-discard',
      'painful-quandary-viewer-opponent-cast-choice',
      'vicious-rumors-viewer-cast-results',
      'rankle-master-of-pranks-viewer-combat-modes',
      'tinybones-joins-up-viewer-multi-player-etb-discard',
      'tinybones-trinket-thief-viewer-opponent-discard-end-step',
      'archon-of-absolution-viewer-taxes-planeswalker-attack',
      'soul-snare-viewer-exiles-planeswalker-attacker',
      'the-haunt-of-hightower-viewer-defender-discard-planeswalker-combat',
      'imp-s-mischief-viewer',
      'restoration-magic-viewer',
      'reluctant-role-model-viewer',
      'bandit-s-talent-viewer',
      'aven-interrupter-viewer-plots-opponent-spell',
      'tergrid-lantern-viewer-target-loses-life',
      'bilbo-s-gambit-viewer-gift-returns-spell',
      'dawn-s-truce-viewer-gift-protects-permanents',
      'perch-protection-viewer-gift-phaseout-next-turn',
      'aven-interrupter-viewer-later-plot-cast-pays-tax',
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
      'planar-void-viewer-destroyed-permanent',
      'library-of-leng-viewer-effect-discard-and-draw',
      'leyline-of-the-void-viewer-opening-hand-and-destruction',
      'liliana-of-the-veil-viewer-each-player-discards',
      'liliana-of-the-veil-viewer-targeted-sacrifice',
      'liliana-waker-of-the-dead-viewer-discard-life-loss',
      'liliana-waker-of-the-dead-viewer-graveyard-scaled-removal',
      'curse-of-disturbance-viewer-two-attackers-one-zombie',
      'promise-of-loyalty-viewer-apnap-vow-and-sacrifice',
      'cloak-of-confusion-viewer-no-damage-random-discard',
      'liliana-of-the-veil-viewer-ultimate-piles',
      'liliana-waker-of-the-dead-viewer-ultimate-emblem-reanimation',
      'tergrid-front-viewer-discards-permanent-card',
      'tergrid-front-viewer-opponent-sacrifice',
      'tergrid-lantern-viewer-discard-then-paid-untap',
      'reluctant-role-model-viewer-death-counter-transfer',
      'bandit-s-talent-viewer-level-three-extra-draw',
      'sejiri-glacier-viewer-next-turn-mother-runes',
      'restoration-magic-viewer-cure',
      'restoration-magic-viewer-curaga',
      'library-of-leng-viewer-no-maximum-hand-size',
      'tinybones-trinket-thief-viewer-empty-hand-activation',
      'archfiend-of-ifnir-viewer-normal-cycling',
      'waste-not-viewer-noncreature-nonland-draw',
      'tinybones-joins-up-viewer-legendary-entry-mill-life',
      'hushbringer-viewer-suppresses-creature-death-trigger',
      'archon-of-emeria-viewer-single-spell-limit',
      'rankle-master-of-pranks-viewer-all-three-modes',
      'doorkeeper-thrull-viewer-flash-suppresses-incoming-entry',
      'breena-viewer-flying-blocker',
      'archfiend-of-ifnir-viewer-flying-blocker',
      'hypnotic-specter-viewer-flying-blocker',
      'aven-interrupter-viewer-flying-blocker',
      'the-haunt-of-hightower-viewer-flying-blocker',
      'doorkeeper-thrull-viewer-flying-blocker',
      'archon-of-absolution-viewer-protection-blocker',
      'tergrid-front-viewer-menace-blocker',
    ];
    expect(requirements.evidenceSemantics.factoryReadyViewerScenarioIds).toEqual(ready);
    const requirementViewerIds = (value: string | string[] | undefined): string[] =>
      value === undefined ? [] : Array.isArray(value) ? value : [value];
    for (const requirementCard of requirements.cards) {
      const manifestCard = manifest.cards[requirementCard.oracleId];
      expect(manifestCard, requirementCard.cardName).toBeDefined();
      expect(requirementCard.clauses, requirementCard.cardName).toHaveLength(
        manifestCard!.clauses.length,
      );
      for (let index = 0; index < manifestCard!.clauses.length; index++) {
        expect(
          requirementViewerIds(requirementCard.clauses[index]!.requiredScenarioIds.viewer),
          `${requirementCard.cardName} clause ${index + 1} requirement viewer mappings`,
        ).toEqual(manifestCard!.clauses[index]!.viewerScenarioIds);
      }
      expect(requirementViewerIds(requirementCard.requiredScenarioIds.viewer)).toEqual([
        ...new Set(manifestCard!.clauses.flatMap((clause) => clause.viewerScenarioIds)),
      ]);
    }

    const entryFactory = readFileSync(
      'packages/server/src/cards/white-black-control-entry-scenarios.ts',
      'utf8',
    );
    const entrySpec = readFileSync('apps/web/e2e/white-black-control-entry.spec.ts', 'utf8');
    for (const id of ready.slice(5, 10)) {
      expect(entryFactory, `entry factory is missing ${id}`).toContain(id);
    }
    for (const title of [
      'Authority of the Consuls casts normally and distinguishes own from opposing creature entry',
      'Archon of Emeria casts normally and taps only the opponent nonbasic land',
      'Doorkeeper Thrull casts normally and suppresses an artifact creature trigger',
      'Hushbringer casts normally, retains flying and lifelink, and suppresses creature entry triggers',
      'Karn, Argent Defender casts normally and suppresses artifact creature triggers',
    ]) {
      expect(entrySpec, `entry viewer spec is missing ${title}`).toContain(title);
    }

    const discardFactory = readFileSync(
      'packages/server/src/cards/white-black-control-discard-extension-scenarios.ts',
      'utf8',
    );
    const discardSpec = readFileSync(
      'apps/web/e2e/white-black-control-discard-extension.spec.ts',
      'utf8',
    );
    for (const id of ready.slice(10, 18))
      expect(discardFactory, `discard extension factory is missing ${id}`).toContain(id);
    for (const title of [
      'Archfiend of Ifnir: your discard puts -1/-1 counters on opposing creatures',
      'Waste Not: an opponent discards a creature and a land',
      'Whispers of Emrakul: delirium makes the opponent discard two at random',
      'Painful Quandary: an opponent cast triggers a discard-or-life choice',
      'Vicious Rumors: opponents lose life and discard before milling',
      'Rankle: combat damage lets you choose discard and lose-life/draw modes',
      'Tinybones Joins Up: choose multiple players to discard',
      'Tinybones, Trinket Thief: an opponent discard draws a card at end step',
    ]) {
      expect(discardSpec, `discard extension viewer spec is missing ${title}`).toContain(title);
    }

    const defenderFactory = readFileSync(
      'packages/server/src/cards/white-black-control-defender-scenarios.ts',
      'utf8',
    );
    const defenderSpec = readFileSync('apps/web/e2e/white-black-control-defenders.spec.ts', 'utf8');
    for (const id of ready.slice(18, 21))
      expect(defenderFactory, `defender factory is missing ${id}`).toContain(id);
    for (const title of [
      'Archon of Absolution: P2 pays the attack tax to attack your planeswalker',
      'Soul Snare: pay {W} and sacrifice it to exile a planeswalker attacker',
      'The Haunt of Hightower: its attack makes the planeswalker defender discard',
    ]) {
      expect(defenderSpec, `defender viewer spec is missing ${title}`).toContain(title);
    }

    const spellFactory = readFileSync(
      'packages/server/src/cards/white-black-control-spell-scenarios.ts',
      'utf8',
    );
    const spellSpec = readFileSync('apps/web/e2e/white-black-control-spells.spec.ts', 'utf8');
    for (const id of [...ready.slice(21, 23), ready[65]!, ready[66]!])
      expect(spellFactory, `spell factory is missing ${id}`).toContain(id);
    for (const title of [
      "Imp's Mischief: redirect a normal single-target spell and lose its mana value",
      'Restoration Magic: cast Cura to protect a permanent and gain 3 life',
      'Restoration Magic: cast Cure for its zero additional cost',
      'Restoration Magic: pay Curaga to protect all your permanents and gain 6 life',
    ]) {
      expect(spellSpec, `spell viewer spec is missing ${title}`).toContain(title);
    }

    const finalFactory = readFileSync(
      'packages/server/src/cards/white-black-control-final-scenarios.ts',
      'utf8',
    );
    const finalSpec = readFileSync('apps/web/e2e/white-black-control-final.spec.ts', 'utf8');
    for (const id of ready.slice(25, 29))
      expect(finalFactory, `final factory is missing ${id}`).toContain(id);
    expect(finalFactory).toContain(ready[30]!);
    const perchFactory = readFileSync(
      'packages/server/src/cards/white-black-control-perch-scenarios.ts',
      'utf8',
    );
    expect(perchFactory).toContain(ready[29]!);
    expect(perchFactory).toContain(
      'Perch Protection: gift P2 an extra turn, then phase in with four Birds',
    );
    for (const title of [
      'Aven Interrupter: flash in to exile the opposing spell',
      'Aven Interrupter: cast the plotted spell later and pay the exile tax',
      "Tergrid's Lantern: activate against a player with no discard or sacrifice choice",
      "Bilbo's Gambit: gift a Treasure and return a spell to its owner's hand",
      "Dawn's Truce: gift a card for hexproof and indestructible",
    ])
      expect(finalSpec, `final viewer spec is missing ${title}`).toContain(title);

    const protectionFactory = readFileSync(
      'packages/server/src/cards/white-black-control-protection-scenarios.ts',
      'utf8',
    );
    const protectionSpec = readFileSync(
      'apps/web/e2e/white-black-control-protection.spec.ts',
      'utf8',
    );
    for (const id of ready.slice(31, 35))
      expect(protectionFactory, `protection factory is missing ${id}`).toContain(id);
    for (const title of [
      'Mother of Runes taps and grants the chosen color protection to your creature',
      'Sejiri Shelter pays its normal cost, targets your creature, and grants chosen color protection',
      "Reprieve returns P2's targeted spell to their hand and draws",
      "Rebuff the Wicked counters P2's spell targeting your creature",
    ])
      expect(protectionSpec, `protection viewer spec is missing ${title}`).toContain(title);

    const discardCoreFactory = readFileSync(
      'packages/server/src/cards/white-black-control-discard-core-scenarios.ts',
      'utf8',
    );
    const discardCoreSpec = readFileSync(
      'apps/web/e2e/white-black-control-discard-core.spec.ts',
      'utf8',
    );
    for (const id of ready.slice(35, 42))
      expect(discardCoreFactory, `discard core factory is missing ${id}`).toContain(id);
    for (const title of [
      'Hymn to Tourach: normal cast makes its target discard two cards at random',
      'Bottomless Pit: normal cast triggers random discard at P2’s next upkeep',
      'Necrogen Mists: normal cast lets P2 choose a card at the next upkeep',
      'Hypnotic Specter: unblocked combat damage triggers the random discard',
      'Oppression: its normal cast makes an opponent discard after a spell cast',
      'Syphon Mind: normal cast makes each other player discard and draws three',
      "Geth's Grimoire: normal cast draws for two discards from an opponent's Hymn",
    ])
      expect(discardCoreSpec, `discard core viewer spec is missing ${title}`).toContain(title);

    const graveyardFactory = readFileSync(
      'packages/server/src/cards/white-black-control-graveyard-scenarios.ts',
      'utf8',
    );
    const graveyardSpec = readFileSync(
      'apps/web/e2e/white-black-control-graveyard.spec.ts',
      'utf8',
    );
    for (const id of ready.slice(42, 45))
      expect(graveyardFactory, `graveyard factory is missing ${id}`).toContain(id);
    for (const title of [
      'Rest in Peace casts normally, clears both existing graveyards, and replaces a later destruction',
      'Stone of Erech casts normally, pays {2}, sacrifices, exiles P2’s graveyard, and draws',
      'Stone of Erech replaces a normally cast destruction of an opponent creature',
    ])
      expect(graveyardSpec, `graveyard viewer spec is missing ${title}`).toContain(title);

    const staxFactory = readFileSync(
      'packages/server/src/cards/white-black-control-stax-scenarios.ts',
      'utf8',
    );
    const staxSpec = readFileSync('apps/web/e2e/white-black-control-stax.spec.ts', 'utf8');
    for (const id of ready.slice(45, 47))
      expect(staxFactory, `stax factory is missing ${id}`).toContain(id);
    for (const title of [
      'Rule of Law blocks each player after one spell but allows a land and activation',
      'Deafening Silence blocks a second noncreature spell and allows a creature spell',
    ])
      expect(staxSpec, `stax viewer spec is missing ${title}`).toContain(title);

    const replacementsFactory = readFileSync(
      'packages/server/src/cards/white-black-control-replacements-scenarios.ts',
      'utf8',
    );
    const replacementsSpec = readFileSync(
      'apps/web/e2e/white-black-control-replacements.spec.ts',
      'utf8',
    );
    for (const id of ready.slice(47, 50))
      expect(replacementsFactory, `replacement factory is missing ${id}`).toContain(id);
    for (const clauseId of [
      'planar-void-c01',
      'library-of-leng-c02',
      'leyline-of-the-void-c01',
      'leyline-of-the-void-c02',
    ])
      expect(replacementsFactory, `replacement factory is missing ${clauseId}`).toContain(clauseId);
    for (const title of [
      'Planar Void casts normally, then exiles P2’s permanent destroyed by Generous Gift',
      'Library of Leng puts an effect-discarded card on top and the next normal draw returns it',
      'Leyline of the Void uses its actual opening-hand choice and exiles a destroyed opponent card',
    ])
      expect(replacementsSpec, `replacement viewer spec is missing ${title}`).toContain(title);

    const lilianaFactory = readFileSync(
      'packages/server/src/cards/white-black-control-liliana-scenarios.ts',
      'utf8',
    );
    const lilianaSpec = readFileSync('apps/web/e2e/white-black-control-liliana.spec.ts', 'utf8');
    for (const id of ready.slice(50, 54))
      expect(lilianaFactory, `Liliana factory is missing ${id}`).toContain(id);
    for (const clauseId of [
      'liliana-of-the-veil-c01',
      'liliana-of-the-veil-c02',
      'liliana-waker-of-the-dead-c01',
      'liliana-waker-of-the-dead-c02',
    ])
      expect(lilianaFactory, `Liliana factory is missing ${clauseId}`).toContain(clauseId);
    for (const title of [
      'Liliana of the Veil normally casts and its +1 makes each player discard',
      'Liliana of the Veil normally casts and its −2 makes the targeted player sacrifice a creature',
      'Liliana, Waker of the Dead normally casts and its +1 costs life when opponents cannot discard',
      'Liliana, Waker of the Dead normally casts and its −3 uses your graveyard to kill a creature',
    ])
      expect(lilianaSpec, `Liliana viewer spec is missing ${title}`).toContain(title);

    for (const id of ready.slice(57, 59))
      expect(lilianaFactory, `Liliana factory is missing ${id}`).toContain(id);
    for (const title of [
      'Liliana of the Veil uses its prepared −6 to make P2 divide and sacrifice a pile',
      'Liliana, Waker of the Dead creates its −7 emblem and reanimates at combat with haste',
    ])
      expect(lilianaSpec, `Liliana viewer spec is missing ${title}`).toContain(title);

    const tergridFactory = readFileSync(
      'packages/server/src/cards/white-black-control-tergrid-scenarios.ts',
      'utf8',
    );
    const tergridSpec = readFileSync('apps/web/e2e/white-black-control-tergrid.spec.ts', 'utf8');
    for (const id of ready.slice(59, 62))
      expect(tergridFactory, `Tergrid factory is missing ${id}`).toContain(id);
    for (const title of [
      'Tergrid returns P2’s real permanent card discarded by a normal Duress cast',
      'Tergrid returns P2’s creature sacrificed by a normal Liliana of the Veil activation',
      "Tergrid's Lantern resolves P2's discard choice, then pays {3}{B} to untap",
    ])
      expect(tergridSpec, `Tergrid viewer spec is missing ${title}`).toContain(title);

    const remainingCombatFactory = readFileSync(
      'packages/server/src/cards/white-black-control-remaining-combat-scenarios.ts',
      'utf8',
    );
    const remainingCombatSpec = readFileSync(
      'apps/web/e2e/white-black-control-remaining-combat.spec.ts',
      'utf8',
    );
    for (const id of ready.slice(54, 57))
      expect(remainingCombatFactory, `remaining combat factory is missing ${id}`).toContain(id);
    for (const clauseId of [
      'curse-of-disturbance-c01',
      'curse-of-disturbance-c02',
      'promise-of-loyalty-c01',
      'cloak-of-confusion-c01',
      'cloak-of-confusion-c02',
    ])
      expect(remainingCombatFactory, `remaining combat factory is missing ${clauseId}`).toContain(
        clauseId,
      );
    for (const title of [
      'Curse of Disturbance: two attackers on P2 create one controller Zombie',
      'Promise of Loyalty: each creature player keeps one and gets a public vow counter',
      'Cloak of Confusion: accept no damage and make P2 discard at random',
    ])
      expect(remainingCombatSpec, `remaining combat viewer spec is missing ${title}`).toContain(
        title,
      );

    const counterClassFactory = readFileSync(
      'packages/server/src/cards/white-black-control-counter-class-scenarios.ts',
      'utf8',
    );
    const counterClassSpec = readFileSync(
      'apps/web/e2e/white-black-control-counter-class.spec.ts',
      'utf8',
    );
    for (const id of [...ready.slice(23, 25), ready[62]!, ready[63]!, ready[64]!])
      expect(counterClassFactory, `counter-class factory is missing ${id}`).toContain(id);
    for (const title of [
      'Reluctant Role Model attacks, then chooses a flying counter in the second main phase',
      "Bandit's Talent normally casts, levels twice, and drains an empty opponent hand at upkeep",
      'Reluctant Role Model transfers all counter types from your destroyed creature',
      "Bandit's Talent reaches level 3 and draws once for each low-hand opponent",
      'Sejiri Glacier enters tapped, then pays for a normal Mother of Runes cast next turn',
    ]) {
      expect(counterClassSpec, `counter-class viewer spec is missing ${title}`).toContain(title);
    }

    const handLimitFactory = readFileSync(
      'packages/server/src/cards/white-black-control-hand-limit-scenarios.ts',
      'utf8',
    );
    const handLimitSpec = readFileSync(
      'apps/web/e2e/white-black-control-hand-limit.spec.ts',
      'utf8',
    );
    for (const id of ready.slice(67, 69))
      expect(handLimitFactory, `hand-limit factory is missing ${id}`).toContain(id);
    for (const title of [
      'Library of Leng keeps the normal eight-card hand through cleanup',
      'Tinybones pays its six-mana activation and affects each opponent by hand count',
    ])
      expect(handLimitSpec, `hand-limit viewer spec is missing ${title}`).toContain(title);

    const expectedByName: Record<string, string[]> = {
      'Breena, the Demagogue': [ready[0]!, ready[76]!],
      "Duelist's Heritage": [ready[1]!],
      Duress: [ready[2]!],
      Thoughtseize: [ready[3]!],
      'Dark Confidant': [ready[4]!],
      'Authority of the Consuls': [ready[5]!],
      'Archon of Emeria': [ready[6]!, ready[73]!],
      'Doorkeeper Thrull': [ready[7]!, ready[75]!, ready[81]!],
      Hushbringer: [ready[8]!, ready[72]!],
      'Karn, Argent Defender': [ready[9]!],
      'Archfiend of Ifnir': [ready[10]!, ready[69]!, ready[77]!],
      'Waste Not': [ready[11]!, ready[70]!],
      'Whispers of Emrakul': [ready[12]!],
      'Painful Quandary': [ready[13]!],
      'Vicious Rumors': [ready[14]!],
      'Rankle, Master of Pranks': [ready[15]!, ready[74]!],
      'Tinybones Joins Up': [ready[16]!, ready[71]!],
      'Tinybones, Trinket Thief': [ready[17]!, ready[68]!],
      'Archon of Absolution': [ready[18]!, ready[82]!],
      'Soul Snare': [ready[19]!],
      'The Haunt of Hightower': [ready[20]!, ready[80]!],
      "Imp's Mischief": [ready[21]!],
      'Restoration Magic': [ready[22]!, ready[65]!, ready[66]!],
      'Reluctant Role Model': [ready[23]!, ready[62]!],
      "Bandit's Talent": [ready[24]!, ready[63]!],
      'Aven Interrupter': [ready[25]!, ready[30]!, ready[79]!],
      "Bilbo's Gambit": [ready[27]!],
      "Dawn's Truce": [ready[28]!],
      'Perch Protection': [ready[29]!],
      'Mother of Runes': [ready[31]!],
      'Sejiri Shelter // Sejiri Glacier': [ready[32]!, ready[64]!],
      Reprieve: [ready[33]!],
      'Rebuff the Wicked': [ready[34]!],
      'Hymn to Tourach': [ready[35]!],
      'Bottomless Pit': [ready[36]!],
      'Necrogen Mists': [ready[37]!],
      'Hypnotic Specter': [ready[38]!, ready[78]!],
      Oppression: [ready[39]!],
      'Syphon Mind': [ready[40]!],
      "Geth's Grimoire": [ready[41]!],
      'Rest in Peace': [ready[42]!],
      'Stone of Erech': [ready[44]!, ready[43]!],
      'Rule of Law': [ready[45]!],
      'Deafening Silence': [ready[46]!],
      'Planar Void': [ready[47]!],
      'Library of Leng': [ready[67]!, ready[48]!],
      'Leyline of the Void': [ready[49]!],
      'Liliana of the Veil': [ready[50]!, ready[51]!, ready[57]!],
      'Liliana, Waker of the Dead': [ready[52]!, ready[53]!, ready[58]!],
      "Tergrid, God of Fright // Tergrid's Lantern": [
        ready[59]!,
        ready[60]!,
        ready[26]!,
        ready[61]!,
        ready[83]!,
      ],
      'Curse of Disturbance': [ready[54]!],
      'Promise of Loyalty': [ready[55]!],
      'Cloak of Confusion': [ready[56]!],
    };
    const expectedViewerClauses: Record<string, Record<number, string[]>> = {
      'Aven Interrupter': {
        0: [ready[25]!],
        1: [ready[79]!],
        2: [ready[25]!, ready[30]!],
        3: [ready[30]!],
      },
      "Bilbo's Gambit": { 0: [ready[27]!], 1: [ready[27]!] },
      "Dawn's Truce": { 0: [ready[28]!], 1: [ready[28]!] },
      'Perch Protection': { 0: [ready[29]!], 1: [ready[29]!], 2: [ready[29]!] },
      'Mother of Runes': { 0: [ready[31]!] },
      'Sejiri Shelter // Sejiri Glacier': {
        0: [ready[32]!],
        1: [ready[64]!],
        2: [ready[64]!],
      },
      Reprieve: { 0: [ready[33]!], 1: [ready[33]!] },
      'Rebuff the Wicked': { 0: [ready[34]!] },
      'Reluctant Role Model': { 0: [ready[23]!], 1: [ready[62]!] },
      "Bandit's Talent": {
        0: [ready[24]!, ready[63]!],
        1: [ready[24]!],
        2: [ready[24]!, ready[63]!],
        3: [ready[24]!],
        4: [ready[24]!, ready[63]!],
        5: [ready[63]!],
      },
      'Restoration Magic': {
        0: [ready[22]!, ready[65]!, ready[66]!],
        1: [ready[65]!],
        2: [ready[22]!],
        3: [ready[66]!],
      },
      'Hymn to Tourach': { 0: [ready[35]!] },
      'Bottomless Pit': { 0: [ready[36]!] },
      'Necrogen Mists': { 0: [ready[37]!] },
      'Hypnotic Specter': { 0: [ready[78]!], 1: [ready[38]!] },
      Oppression: { 0: [ready[39]!] },
      'Syphon Mind': { 0: [ready[40]!] },
      "Geth's Grimoire": { 0: [ready[41]!] },
      'Rest in Peace': { 0: [ready[42]!], 1: [ready[42]!] },
      'Stone of Erech': { 0: [ready[44]!], 1: [ready[43]!] },
      'Rule of Law': { 0: [ready[45]!] },
      'Deafening Silence': { 0: [ready[46]!] },
      'Planar Void': { 0: [ready[47]!] },
      'Library of Leng': { 0: [ready[67]!], 1: [ready[48]!] },
      'Leyline of the Void': { 0: [ready[49]!], 1: [ready[49]!] },
      'Liliana of the Veil': { 0: [ready[50]!], 1: [ready[51]!], 2: [ready[57]!] },
      'Liliana, Waker of the Dead': { 0: [ready[52]!], 1: [ready[53]!], 2: [ready[58]!] },
      'Tinybones, Trinket Thief': { 0: [ready[17]!], 1: [ready[68]!] },
      "Tergrid, God of Fright // Tergrid's Lantern": {
        0: [ready[83]!],
        1: [ready[59]!, ready[60]!],
        2: [ready[26]!, ready[61]!],
        3: [ready[61]!],
      },
      'Curse of Disturbance': { 0: [ready[54]!], 1: [ready[54]!] },
      'Promise of Loyalty': { 0: [ready[55]!] },
      'Cloak of Confusion': { 0: [ready[56]!], 1: [ready[56]!] },
    };
    for (const name of authoredNames) {
      const pin = pinned.cards.find(({ card }) => card.name === name)!;
      const entry = manifest.cards[pin.card.oracleId]!;
      const viewerIds = [...new Set(entry.clauses.flatMap((clause) => clause.viewerScenarioIds))];
      expect([...viewerIds].sort(), name).toEqual([...(expectedByName[name] ?? [])].sort());
      if (expectedViewerClauses[name] !== undefined) {
        const requirementsCard = requirements.cards.find((card) => card.cardName === name)!;
        for (let clauseIndex = 0; clauseIndex < entry.clauses.length; clauseIndex++) {
          const expectedClauseViewer = expectedViewerClauses[name][clauseIndex];
          expect(
            entry.clauses[clauseIndex]!.viewerScenarioIds,
            `${name} manifest clause ${clauseIndex + 1} viewer scenarios`,
          ).toEqual(expectedClauseViewer ?? []);
          const requirementViewer =
            requirementsCard.clauses[clauseIndex]!.requiredScenarioIds.viewer;
          expect(
            Array.isArray(requirementViewer)
              ? requirementViewer
              : requirementViewer === undefined
                ? []
                : [requirementViewer],
            `${name} requirements clause ${clauseIndex + 1} viewer scenario`,
          ).toEqual(expectedClauseViewer ?? []);
        }
      }
    }
  });

  it('keeps future viewer and gameplay-AI checks as requirements only', () => {
    expect(requirements.evidenceSemantics.futureViewerScenarioIdsAreRequirementsOnly).toBe(true);
    for (const card of requirements.cards)
      expect(card.implementationStatus, card.cardName).toBe('implemented-unreviewed');
    const perch = requirements.cards.find(({ cardName }) => cardName === 'Perch Protection')!;
    expect(perch.requiredScenarioIds.viewer).toBe(
      'perch-protection-viewer-gift-phaseout-next-turn',
    );
    expect(perch.requiredScenarioIds.gameplayAi).toBe('perch-protection-gameplay-ai');
    expect(perch.remainingViewerRequirements?.join(' ')).toContain('real Playwright run');
    const aven = requirements.cards.find(({ cardName }) => cardName === 'Aven Interrupter')!;
    expect(aven.requiredScenarioIds.viewer).toEqual([
      'aven-interrupter-viewer-plots-opponent-spell',
      'aven-interrupter-viewer-flying-blocker',
      'aven-interrupter-viewer-later-plot-cast-pays-tax',
    ]);
    expect(aven.remainingViewerRequirements).toBeUndefined();
  });
});
