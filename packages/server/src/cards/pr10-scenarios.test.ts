import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DecisionRequest, LegalAction, OracleCard } from '@mtg/shared';
import { PR10_ALL_SCENARIOS } from './pr10-scenario-catalog';
import { PR10_SCENARIOS, pr10Scenario } from './pr10-scenarios';

const pinFile = JSON.parse(
  readFileSync(
    new URL(
      '../../../../packages/engine/tests/fixtures/coverage-pr10-oracle.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { cards: { sha256: string; card: OracleCard }[] };

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** What P1 does in the viewer, expressed as engine actions. */
interface Plan {
  /** Spells to cast in order, with the preferred target of each slot (a seat id or a stack spell). */
  casts: {
    name: string;
    /** What the step does: cast a spell (default), activate a permanent's ability, or play a land. */
    kind?: 'cast' | 'activate' | 'play' | 'ability';
    /** Only an action whose description matches this (one of several abilities of a permanent). */
    match?: RegExp;
    targets?: string[];
    alternative?: boolean;
    /** Cast only once the stack is empty ('empty') or holds an object whose name contains this. */
    when?: string;
  }[];
  /** Decision options P1 picks, matched against the option description, in priority order. */
  picks?: RegExp[];
  /** Targets P1 chooses, in order, whenever a triggered ability asks for them. */
  triggerTargets?: string[][];
}

/** Every card with Card Test Lab scenarios, grouped as the overrides are registered. */
const CARD_NAMES = [
  // Retarget, spell copy and cast copy.
  'Deflecting Swat',
  'Bolt Bend',
  'Reverberate',
  'Flare of Duplication',
  'Display of Power',
  'Galvanic Iteration',
  'Cosmic Crucible',
  // Ability stack.
  'Siren Stormtamer',
  'Mana Sculpt',
  'Mister Fantastic',
  'Verrak, Warped Sengir',
  // Trigger doubling.
  'Roaming Throne',
  'Annie Joins Up',
  // Animation and becoming a copy.
  'Atarka Monument',
  'Sarkhan, the Dragonspeaker',
  'Mirage Mirror',
  'Saheeli, Sublime Artificer',
  // Token copies.
  'Scute Swarm',
  'Council of Reeds',
  'Twilight Diviner',
  'Saheeli, Radiant Creator',
  'Mocking Doppelganger',
  // Characteristics.
  'Duplicant',
  'Nighthawk Scavenger',
  'Xenagos, God of Revels',
  'Trazyn the Infinite',
  'Reality Shift',
  'Dragon Man, Reformed Robot',
  'Rowan Kenrith',
  'Biotransference',
];

const SHOCK_AT_P3 = (card: string): Plan => ({
  casts: [{ name: card, targets: ['PR10 Lab Shock'], when: 'PR10 Lab Shock' }],
  picks: [/^Target P4$/],
});

const PLANS: Record<string, Plan> = {
  'pr10-deflecting-swat-viewer-positive': SHOCK_AT_P3('Deflecting Swat'),
  'pr10-deflecting-swat-viewer-negative': {
    casts: [{ name: 'Deflecting Swat', targets: ['PR10 Lab Shock'], when: 'PR10 Lab Shock' }],
    picks: [/^Keep P3 as the target$/],
  },
  'pr10-deflecting-swat-viewer-commander': SHOCK_AT_P3('Deflecting Swat'),
  'pr10-deflecting-swat-viewer-no-commander': { casts: [] },
  'pr10-bolt-bend-viewer-positive': SHOCK_AT_P3('Bolt Bend'),
  'pr10-bolt-bend-viewer-negative': { casts: [] },
  'pr10-bolt-bend-viewer-reduction': SHOCK_AT_P3('Bolt Bend'),
  'pr10-bolt-bend-viewer-no-reduction': { casts: [] },
  'pr10-reverberate-viewer-positive': SHOCK_AT_P3('Reverberate'),
  'pr10-reverberate-viewer-negative': { casts: [] },
  'pr10-flare-of-duplication-viewer-positive': SHOCK_AT_P3('Flare of Duplication'),
  'pr10-flare-of-duplication-viewer-negative': { casts: [] },
  'pr10-flare-of-duplication-viewer-sacrifice': {
    casts: [
      {
        name: 'Flare of Duplication',
        targets: ['PR10 Lab Shock'],
        alternative: true,
        when: 'PR10 Lab Shock',
      },
    ],
    picks: [/^Target P4$/],
  },
  'pr10-flare-of-duplication-viewer-no-sacrifice': { casts: [] },
  'pr10-display-of-power-viewer-positive': {
    casts: [
      { name: 'PR10 Lab Zap', targets: ['P2'], when: 'PR10 Lab Shock' },
      { name: 'Display of Power' },
    ],
    picks: [
      /^Target PR10 Lab Shock \(on the stack\)$/,
      /^Target PR10 Lab Zap \(on the stack\)$/,
      /^Target P4$/,
      /^Target P4$/,
    ],
  },
  'pr10-display-of-power-viewer-negative': { casts: [{ name: 'Display of Power' }] },
  'pr10-display-of-power-viewer-cant-be-copied': {
    casts: [{ name: 'Display of Power' }, { name: 'Reverberate', targets: ['Display of Power'] }],
  },
  'pr10-galvanic-iteration-viewer-positive': {
    casts: [
      { name: 'Galvanic Iteration' },
      { name: 'PR10 Lab Shock', targets: ['P2'], when: 'empty' },
    ],
    picks: [/^Target P3$/],
  },
  'pr10-galvanic-iteration-viewer-negative': {
    casts: [{ name: 'Galvanic Iteration' }, { name: 'PR10 Lab Bear', when: 'empty' }],
  },
  'pr10-galvanic-iteration-viewer-flashback': { casts: [{ name: 'Galvanic Iteration' }] },
  'pr10-cosmic-crucible-viewer-mana': { casts: [], picks: [/^Distribute 4 mana \(allowed: \{R\}/] },
  'pr10-cosmic-crucible-viewer-copy': {
    casts: [{ name: 'PR10 Lab Shock', targets: ['P2'] }],
    picks: [/^Copy PR10 Lab Shock$/, /^Target P3$/],
  },
  'pr10-cosmic-crucible-viewer-once-each-turn': {
    casts: [
      { name: 'PR10 Lab Shock', targets: ['P2'] },
      { name: 'PR10 Lab Zap', targets: ['P2'], when: 'Copy of PR10 Lab Shock' },
    ],
    picks: [/^Copy PR10 Lab Shock$/, /^Target P3$/],
  },
  'pr10-cosmic-crucible-viewer-negative': { casts: [{ name: 'PR10 Lab Red Bear' }] },

  // PR10.08 Siren Stormtamer
  'pr10-siren-stormtamer-viewer-counter-spell': {
    casts: [
      {
        name: 'Siren Stormtamer',
        kind: 'activate',
        targets: ['PR10 Lab Shock'],
        when: 'PR10 Lab Shock',
      },
    ],
  },
  'pr10-siren-stormtamer-viewer-counter-ability': {
    casts: [
      {
        name: 'Siren Stormtamer',
        kind: 'activate',
        targets: ['PR10 Lab Pinger'],
        when: 'PR10 Lab Pinger',
      },
    ],
  },
  'pr10-siren-stormtamer-viewer-not-your-target': { casts: [] },
  // PR10.04 Mana Sculpt
  'pr10-mana-sculpt-viewer-wizard': {
    casts: [{ name: 'Mana Sculpt', targets: ['PR10 Lab Cinder'], when: 'PR10 Lab Cinder' }],
  },
  'pr10-mana-sculpt-viewer-no-wizard': {
    casts: [{ name: 'Mana Sculpt', targets: ['PR10 Lab Cinder'], when: 'PR10 Lab Cinder' }],
  },
  // PR10.21 Mister Fantastic
  'pr10-mister-fantastic-viewer-copy-twice': {
    casts: [
      { name: 'Swamp', kind: 'play' },
      {
        name: 'Mister Fantastic',
        kind: 'activate',
        targets: ['PR10 Lab Landfall Sparker'],
        when: 'PR10 Lab Landfall Sparker',
      },
    ],
    triggerTargets: [['P2']],
    picks: [/^Target P3$/, /^Target P4$/],
  },
  'pr10-mister-fantastic-viewer-opponent-trigger': { casts: [] },
  'pr10-mister-fantastic-viewer-combat-draw': {
    casts: [{ name: 'PR10 Lab Zap', targets: ['P2'] }],
  },
  'pr10-mister-fantastic-viewer-combat-no-draw': { casts: [] },
  // PR10.10 Verrak, Warped Sengir
  'pr10-verrak-warped-sengir-viewer-pay-again': {
    casts: [{ name: 'PR10 Lab Bloodletter', kind: 'activate' }],
    picks: [/^Pay 2 life$/],
  },
  'pr10-verrak-warped-sengir-viewer-decline': {
    casts: [{ name: 'PR10 Lab Bloodletter', kind: 'activate' }],
    picks: [/^Decline$/],
  },
  'pr10-verrak-warped-sengir-viewer-new-target': {
    casts: [{ name: 'PR10 Lab Blood Pinger', kind: 'activate', targets: ['P2'] }],
    picks: [/^Pay 1 life$/, /^Target P3$/],
  },
  'pr10-verrak-warped-sengir-viewer-no-life': {
    casts: [{ name: 'PR10 Lab Scholar', kind: 'activate' }],
  },
  // PR10.18 Roaming Throne
  'pr10-roaming-throne-viewer-chosen-type-doubles': {
    casts: [{ name: 'Roaming Throne' }, { name: 'PR10 Lab Elf Healer' }],
    picks: [/^Elf$/],
  },
  'pr10-roaming-throne-viewer-other-type': {
    casts: [{ name: 'Roaming Throne' }, { name: 'PR10 Lab Bear Healer' }],
    picks: [/^Elf$/],
  },
  // PR10.24 Annie Joins Up
  'pr10-annie-joins-up-viewer-enter-damage': { casts: [{ name: 'Annie Joins Up' }] },
  'pr10-annie-joins-up-viewer-doubles-legendary': {
    casts: [{ name: 'PR10 Lab Legend Healer' }],
  },
  'pr10-annie-joins-up-viewer-nonlegendary': { casts: [{ name: 'PR10 Lab Commoner Healer' }] },
  // PR10.02 Atarka Monument
  'pr10-atarka-monument-viewer-animate': {
    casts: [{ name: 'Atarka Monument', kind: 'activate' }],
  },
  'pr10-atarka-monument-viewer-insufficient-cost': { casts: [] },
  'pr10-atarka-monument-viewer-mana': { casts: [{ name: 'PR10 Lab Zap', targets: ['P2'] }] },
  // PR10.17 Sarkhan, the Dragonspeaker
  'pr10-sarkhan-the-dragonspeaker-viewer-plus-one': {
    casts: [{ name: 'Sarkhan, the Dragonspeaker', kind: 'activate', match: /becomes a legendary/ }],
  },
  'pr10-sarkhan-the-dragonspeaker-viewer-minus-three': {
    casts: [
      {
        name: 'Sarkhan, the Dragonspeaker',
        kind: 'activate',
        match: /deals 4 damage/,
        targets: ['PR10 Lab Brute'],
      },
    ],
  },
  'pr10-sarkhan-the-dragonspeaker-viewer-emblem': {
    casts: [{ name: 'Sarkhan, the Dragonspeaker', kind: 'activate', match: /emblem/ }],
  },
  // PR10.20 Mirage Mirror
  'pr10-mirage-mirror-viewer-becomes-copy': {
    casts: [{ name: 'Mirage Mirror', kind: 'activate', targets: ['PR10 Lab Brute'] }],
  },
  'pr10-mirage-mirror-viewer-insufficient-cost': { casts: [] },
  // PR10.07 Saheeli, Sublime Artificer
  'pr10-saheeli-sublime-artificer-viewer-servo': {
    casts: [{ name: 'PR10 Lab Zap', targets: ['P2'] }],
  },
  'pr10-saheeli-sublime-artificer-viewer-minus-two': {
    casts: [
      {
        name: 'Saheeli, Sublime Artificer',
        kind: 'activate',
        targets: ['PR10 Lab Trinket', 'PR10 Lab Bear'],
      },
    ],
  }, // PR10.17 Scute Swarm
  'pr10-scute-swarm-viewer-insect': { casts: [{ name: 'Swamp', kind: 'play' }] },
  'pr10-scute-swarm-viewer-copy': { casts: [{ name: 'Swamp', kind: 'play' }] },
  // PR10.16 Council of Reeds
  'pr10-council-of-reeds-viewer-legend-rule': { casts: [{ name: 'PR10 Lab Commander' }] },
  'pr10-council-of-reeds-viewer-combat-copy': {
    casts: [{ name: 'PR10 Lab Zap', targets: ['P2'] }],
  },
  'pr10-council-of-reeds-viewer-combat-no-copy': { casts: [{ name: 'PR10 Lab Red Bear' }] },
  // PR10.18 Twilight Diviner
  'pr10-twilight-diviner-viewer-surveil': {
    casts: [{ name: 'Twilight Diviner' }],
    picks: [/^Put PR10 Lab Bear into your graveyard$/],
  },
  'pr10-twilight-diviner-viewer-from-graveyard': {
    casts: [{ name: 'PR10 Lab Reanimate' }],
  },
  'pr10-twilight-diviner-viewer-from-hand': { casts: [{ name: 'PR10 Lab Bear' }] },
  // PR10.07 Saheeli, Radiant Creator
  'pr10-saheeli-radiant-creator-viewer-energy': { casts: [{ name: 'PR10 Lab Trinket' }] },
  'pr10-saheeli-radiant-creator-viewer-combat-copy': {
    casts: [],
    picks: [/^Pay 3 energy$/],
    triggerTargets: [['PR10 Lab Brute']],
  },
  'pr10-saheeli-radiant-creator-viewer-not-enough-energy': { casts: [] },
  'pr10-saheeli-radiant-creator-viewer-decline': { casts: [], picks: [/^Pay no energy$/] },
  // PR10.22 Mocking Doppelganger
  'pr10-mocking-doppelganger-viewer-copy': {
    casts: [{ name: 'Mocking Doppelganger' }],
    picks: [/^Copy PR10 Lab Brute$/],
  },
  'pr10-mocking-doppelganger-viewer-decline': {
    casts: [{ name: 'Mocking Doppelganger' }],
    picks: [/^Enter normally$/],
  }, // PR10.13 Duplicant
  'pr10-duplicant-viewer-exile': {
    casts: [{ name: 'Duplicant' }],
    triggerTargets: [['PR10 Lab Brute']],
    picks: [/^Yes$/],
  },
  'pr10-duplicant-viewer-decline': {
    casts: [{ name: 'Duplicant' }],
    triggerTargets: [['PR10 Lab Brute']],
    picks: [/^No$/],
  },
  // PR10.15 Nighthawk Scavenger
  'pr10-nighthawk-scavenger-viewer-empty': { casts: [] },
  'pr10-nighthawk-scavenger-viewer-counts-types': { casts: [] },
  'pr10-nighthawk-scavenger-viewer-own-graveyard': {
    casts: [{ name: 'PR10 Lab Zap', targets: ['P2'] }],
  },
  // PR10.28 Xenagos, God of Revels
  'pr10-xenagos-god-of-revels-viewer-low-devotion': { casts: [] },
  'pr10-xenagos-god-of-revels-viewer-seven-devotion': { casts: [] },
  'pr10-xenagos-god-of-revels-viewer-combat': { casts: [] },
  // PR10.09 Trazyn the Infinite
  'pr10-trazyn-the-infinite-viewer-activated': {
    casts: [{ name: 'Trazyn the Infinite', kind: 'activate' }],
  },
  'pr10-trazyn-the-infinite-viewer-mana': {
    casts: [{ name: 'PR10 Lab Zap', targets: ['P2'] }],
  },
  'pr10-trazyn-the-infinite-viewer-scope': { casts: [] },
  // PR10.05 Reality Shift
  'pr10-reality-shift-viewer-manifest': {
    casts: [{ name: 'Reality Shift', targets: ['PR10 Lab Brute'] }],
  },
  'pr10-reality-shift-viewer-turn-face-up': {
    casts: [
      { name: 'Reality Shift', targets: ['PR10 Lab Bear'] },
      { name: 'Turn PR10 Lab Red Bear face up', kind: 'ability' },
    ],
  },
  // PR10.29 Dragon Man, Reformed Robot
  'pr10-dragon-man-reformed-robot-viewer-power': { casts: [] },
  'pr10-dragon-man-reformed-robot-viewer-excludes': { casts: [] },
  'pr10-dragon-man-reformed-robot-viewer-graveyard-cast': {
    casts: [{ name: 'Dragon Man, Reformed Robot' }],
  },
  // PR10.30 Rowan Kenrith
  'pr10-rowan-kenrith-viewer-plus-two': {
    casts: [
      {
        name: 'Rowan Kenrith',
        kind: 'activate',
        match: /During target player/,
        targets: ['P3'],
      },
    ],
  },
  'pr10-rowan-kenrith-viewer-minus-two': {
    casts: [{ name: 'Rowan Kenrith', kind: 'activate', match: /deals 3 damage/, targets: ['P3'] }],
  },
  'pr10-rowan-kenrith-viewer-emblem': {
    casts: [{ name: 'Rowan Kenrith', kind: 'activate', match: /emblem/, targets: ['P1'] }],
  },
  'pr10-rowan-kenrith-viewer-partner': {
    casts: [{ name: 'Rowan Kenrith' }],
    triggerTargets: [['P1']],
    picks: [/^Don't search$/],
  },
  'pr10-rowan-kenrith-viewer-commander': {
    casts: [{ name: 'Rowan Kenrith' }],
    triggerTargets: [['P1']],
    picks: [/^Don't search$/],
  },
  // PR10.03 Biotransference
  'pr10-biotransference-viewer-artifact-spell': { casts: [{ name: 'PR10 Lab Red Bear' }] },
  'pr10-biotransference-viewer-noncreature-spell': {
    casts: [{ name: 'PR10 Lab Zap', targets: ['P2'] }],
  },
  'pr10-biotransference-viewer-opponents-spell': { casts: [] },
};

/** The legal target matching `want`: a seat id, or the name of a permanent or stack object. */
function targetChoice(
  state: ReturnType<ReturnType<typeof pr10Scenario>['engine']['getState']>,
  options: string[],
  want: string | undefined,
): string {
  if (want !== undefined && options.includes(want)) return want;
  const named = [...state.battlefield, ...state.stack].find(
    (item) =>
      options.includes(item.id) &&
      ('name' in item ? item.name === want : item.description.includes(want ?? '\0')),
  );
  return named?.id ?? options[0]!;
}

const ACTION_TYPE = {
  cast: 'castSpell',
  activate: 'activateAbility',
  play: 'playLand',
  ability: 'activateAbility',
} as const;

function run(id: string) {
  const scenario = pr10Scenario(id, `server-${id}` as never);
  const plan = PLANS[id]!;
  const castQueue = [...plan.casts];
  const picks = [...(plan.picks ?? [])];
  const triggerTargets = [...(plan.triggerTargets ?? [])];
  const offered = new Set<string>();
  const options: string[] = [];
  const casts: string[] = [];
  let decisions = 0;
  for (;;) {
    const step = scenario.engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    const request = step.request as DecisionRequest;
    if (request.decidingPlayer !== 'P1') {
      const provider = scenario.decisionProviderOverrides?.[request.decidingPlayer];
      if (provider !== undefined) {
        scenario.engine.submit(provider.decide(request));
        continue;
      }
      const pass = request.legalActions.find((action) => action.type === 'pass');
      scenario.engine.submit({
        requestId: request.requestId,
        actionId: (pass ?? request.legalActions[0]!).id,
      });
      continue;
    }
    for (const action of request.legalActions) offered.add(action.description);
    const next = castQueue[0];
    let action: LegalAction | undefined;
    let targets: { slot: number; choice: string }[] | undefined;
    const state = scenario.engine.getState();
    const stack = state.stack;
    const ready =
      next?.when === undefined ||
      (next.when === 'empty'
        ? stack.length === 0
        : stack.some((item) => item.description.includes(next.when!)));
    if (next !== undefined && ready) {
      const kind = next.kind ?? 'cast';
      const label = {
        cast: `Cast ${next.name}`,
        activate: `${next.name}:`,
        play: `Play ${next.name}`,
        ability: next.name,
      }[kind];
      const matching = request.legalActions.filter(
        (candidate) =>
          candidate.type === ACTION_TYPE[kind] &&
          candidate.description.startsWith(label) &&
          (next.match === undefined || next.match.test(candidate.description)),
      );
      action = next.alternative
        ? matching.find((candidate) => candidate.data?.['castVariant'] === 'nonMana')
        : (matching.find((candidate) => candidate.data?.['castVariant'] === undefined) ??
          matching[0]);
      if (action !== undefined) {
        castQueue.shift();
        casts.push(next.name);
        targets = (action.targets ?? []).map((slot) => ({
          slot: slot.slot,
          choice: targetChoice(state, slot.options, next.targets?.[slot.slot]),
        }));
      }
    }
    if (action === undefined) {
      const asked = request.legalActions.find((candidate) => candidate.type === 'chooseTargets');
      if (asked !== undefined) {
        action = asked;
        const want = triggerTargets.shift();
        targets = (asked.targets ?? []).map((slot) => ({
          slot: slot.slot,
          choice: targetChoice(state, slot.options, want?.[slot.slot]),
        }));
      }
    }
    if (action === undefined) {
      const pickable = request.legalActions.filter((candidate) => candidate.type !== 'pass');
      for (const pattern of picks) {
        const found = pickable.find((candidate) => pattern.test(candidate.description));
        if (found !== undefined) {
          action = found;
          options.push(found.description);
          picks.splice(picks.indexOf(pattern), 1);
          break;
        }
      }
    }
    action ??= request.legalActions.find((candidate) => candidate.type === 'pass');
    action ??= request.legalActions[0]!;
    if (targets === undefined && action.targets !== undefined && action.targets.length > 0) {
      // A decision with no scripted choice: decline to attack, otherwise take the first option.
      targets = action.targets.map((slot) => ({
        slot: slot.slot,
        choice: slot.options.includes('__no_attack__') ? '__no_attack__' : slot.options[0]!,
      }));
    }
    scenario.engine.submit({
      requestId: request.requestId,
      actionId: action.id,
      ...(targets !== undefined ? { targets } : {}),
    });
    if (++decisions > 200) throw new Error(`${id} exceeded 200 decisions`);
  }
  return { scenario, offered, options, casts, state: scenario.engine.getState() };
}

describe('PR10 Card Test Lab scenarios', () => {
  it('declares the stable catalog for the PR10 cards', () => {
    expect(PR10_ALL_SCENARIOS).toEqual(PR10_SCENARIOS);
    expect(new Set(PR10_SCENARIOS.map((scenario) => scenario.id)).size).toBe(PR10_SCENARIOS.length);
    expect(new Set(PR10_SCENARIOS.map((scenario) => scenario.title)).size).toBe(
      PR10_SCENARIOS.length,
    );
    expect(new Set(PR10_SCENARIOS.map((scenario) => scenario.cardName))).toEqual(
      new Set(CARD_NAMES),
    );
    expect(Object.keys(PLANS).sort()).toEqual(PR10_SCENARIOS.map((scenario) => scenario.id).sort());
  });

  it.each(PR10_SCENARIOS)(
    '$id binds the exact pinned Oracle text and real ordered clauses',
    ({ id, cardName }) => {
      const pin = pinFile.cards.find((entry) => entry.card.name === cardName)!;
      expect(createHash('sha256').update(JSON.stringify(pin.card)).digest('hex')).toBe(pin.sha256);
      const scenario = pr10Scenario(id, `pin-${id}` as never);
      expect(scenario.metadata.id).toBe(id);
      expect(scenario.metadata.oracleSha256).toBe(pin.sha256);
      const valid = pin.card.oracleText
        .split('\n')
        .map((_, index) => `pr10-${slug(cardName)}-clause-${index + 1}`);
      expect(scenario.metadata.clauseIds.length).toBeGreaterThan(0);
      for (const clauseId of scenario.metadata.clauseIds) expect(valid).toContain(clauseId);
    },
  );

  it('keeps every scenario free of unmodeled cards', () => {
    for (const { id } of PR10_SCENARIOS) {
      const scenario = pr10Scenario(id, `modeled-${id}` as never);
      const state = scenario.engine.getState();
      expect(state.eventLog.filter((event) => event.type === 'engineHalt')).toHaveLength(0);
    }
  });

  const EXPECTATIONS: Record<
    string,
    {
      lives: Partial<Record<string, number>>;
      copies: number;
      absent?: string;
      present?: string[];
      /** Exact number of events of each type in the log. */
      events?: Record<string, number>;
    }
  > = {
    'pr10-deflecting-swat-viewer-positive': { lives: { P3: 40, P4: 38 }, copies: 0 },
    'pr10-deflecting-swat-viewer-negative': { lives: { P3: 38, P4: 40 }, copies: 0 },
    'pr10-deflecting-swat-viewer-commander': {
      lives: { P3: 40, P4: 38 },
      copies: 0,
      present: [
        'Cast Deflecting Swat ({0}) without paying its mana cost (you control a commander)',
      ],
    },
    'pr10-deflecting-swat-viewer-no-commander': {
      lives: { P3: 38, P4: 40 },
      copies: 0,
      absent: 'Cast Deflecting Swat',
    },
    'pr10-bolt-bend-viewer-positive': { lives: { P3: 40, P4: 38 }, copies: 0 },
    'pr10-bolt-bend-viewer-negative': { lives: { P3: 40 }, copies: 0, absent: 'Cast Bolt Bend' },
    'pr10-bolt-bend-viewer-reduction': {
      lives: { P3: 40, P4: 38 },
      copies: 0,
      present: ['Cast Bolt Bend ({R})'],
    },
    'pr10-bolt-bend-viewer-no-reduction': {
      lives: { P3: 38 },
      copies: 0,
      absent: 'Cast Bolt Bend',
    },
    'pr10-reverberate-viewer-positive': { lives: { P3: 38, P4: 38 }, copies: 1 },
    'pr10-reverberate-viewer-negative': {
      lives: { P3: 40 },
      copies: 0,
      absent: 'Cast Reverberate',
    },
    'pr10-flare-of-duplication-viewer-positive': { lives: { P3: 38, P4: 38 }, copies: 1 },
    'pr10-flare-of-duplication-viewer-negative': {
      lives: { P3: 40 },
      copies: 0,
      absent: 'Cast Flare of Duplication',
    },
    'pr10-flare-of-duplication-viewer-sacrifice': {
      lives: { P3: 38, P4: 38 },
      copies: 1,
      present: ['Cast Flare of Duplication ({0}) (alternate cost)'],
    },
    'pr10-flare-of-duplication-viewer-no-sacrifice': {
      lives: { P3: 38 },
      copies: 0,
      absent: 'Cast Flare of Duplication',
    },
    'pr10-display-of-power-viewer-positive': { lives: { P2: 39, P3: 38, P4: 37 }, copies: 2 },
    'pr10-display-of-power-viewer-negative': { lives: {}, copies: 0 },
    'pr10-display-of-power-viewer-cant-be-copied': { lives: {}, copies: 0 },
    'pr10-galvanic-iteration-viewer-positive': { lives: { P2: 38, P3: 38 }, copies: 1 },
    'pr10-galvanic-iteration-viewer-negative': { lives: {}, copies: 0 },
    'pr10-galvanic-iteration-viewer-flashback': {
      lives: {},
      copies: 0,
      present: ['Cast Galvanic Iteration ({1}{U}{R}) (alternate cost) from your graveyard'],
    },
    'pr10-cosmic-crucible-viewer-mana': { lives: {}, copies: 0 },
    'pr10-cosmic-crucible-viewer-copy': { lives: { P2: 38, P3: 38 }, copies: 1 },
    'pr10-cosmic-crucible-viewer-once-each-turn': { lives: { P2: 37, P3: 38 }, copies: 1 },
    'pr10-cosmic-crucible-viewer-negative': { lives: {}, copies: 0 },
    'pr10-siren-stormtamer-viewer-counter-spell': {
      lives: { P1: 40 },
      copies: 0,
      events: { counterSpell: 1, damage: 0, sacrifice: 1 },
    },
    'pr10-siren-stormtamer-viewer-counter-ability': {
      lives: { P1: 40 },
      copies: 0,
      events: { counterSpell: 1, damage: 0 },
    },
    'pr10-siren-stormtamer-viewer-not-your-target': {
      lives: { P3: 38 },
      copies: 0,
      absent: 'Siren Stormtamer:',
      events: { counterSpell: 0 },
    },
    'pr10-mana-sculpt-viewer-wizard': {
      lives: { P3: 40 },
      copies: 0,
      events: { counterSpell: 1, manaAdded: 1 },
    },
    'pr10-mana-sculpt-viewer-no-wizard': {
      lives: { P3: 40 },
      copies: 0,
      events: { counterSpell: 1, manaAdded: 0 },
    },
    'pr10-mister-fantastic-viewer-copy-twice': {
      lives: { P2: 39, P3: 39, P4: 39 },
      copies: 0,
      events: { abilityCopied: 2, damage: 3 },
    },
    'pr10-mister-fantastic-viewer-opponent-trigger': {
      lives: { P3: 39 },
      copies: 0,
      absent: 'Mister Fantastic:',
      events: { abilityCopied: 0 },
    },
    'pr10-mister-fantastic-viewer-combat-draw': {
      lives: { P2: 39 },
      copies: 0,
      events: { draw: 1 },
    },
    'pr10-mister-fantastic-viewer-combat-no-draw': { lives: {}, copies: 0, events: { draw: 0 } },
    'pr10-verrak-warped-sengir-viewer-pay-again': {
      lives: { P1: 36 },
      copies: 0,
      events: { abilityCopied: 1, draw: 2 },
    },
    'pr10-verrak-warped-sengir-viewer-decline': {
      lives: { P1: 38 },
      copies: 0,
      events: { abilityCopied: 0, draw: 1 },
    },
    'pr10-verrak-warped-sengir-viewer-new-target': {
      lives: { P1: 38, P2: 39, P3: 39 },
      copies: 0,
      events: { abilityCopied: 1, damage: 2 },
    },
    'pr10-verrak-warped-sengir-viewer-no-life': {
      lives: { P1: 40 },
      copies: 0,
      absent: 'Pay ',
      events: { abilityCopied: 0, draw: 1 },
    },
    'pr10-roaming-throne-viewer-chosen-type-doubles': {
      lives: { P1: 46 },
      copies: 0,
      events: { lifeGain: 2 },
    },
    'pr10-roaming-throne-viewer-other-type': {
      lives: { P1: 43 },
      copies: 0,
      events: { lifeGain: 1 },
    },
    'pr10-annie-joins-up-viewer-enter-damage': {
      lives: { P1: 40 },
      copies: 0,
      events: { damage: 1, sbaCreatureDies: 1 },
    },
    'pr10-annie-joins-up-viewer-doubles-legendary': {
      lives: { P1: 46 },
      copies: 0,
      events: { lifeGain: 2 },
    },
    'pr10-annie-joins-up-viewer-nonlegendary': {
      lives: { P1: 43 },
      copies: 0,
      events: { lifeGain: 1 },
    },
    'pr10-atarka-monument-viewer-animate': { lives: {}, copies: 0, events: { becomeCreature: 1 } },
    'pr10-atarka-monument-viewer-insufficient-cost': {
      lives: {},
      copies: 0,
      absent: 'Atarka Monument:',
      events: { becomeCreature: 0 },
    },
    'pr10-atarka-monument-viewer-mana': { lives: { P2: 39 }, copies: 0, events: { castSpell: 1 } },
    'pr10-sarkhan-the-dragonspeaker-viewer-plus-one': {
      lives: {},
      copies: 0,
      events: { becomeCreature: 1 },
    },
    'pr10-sarkhan-the-dragonspeaker-viewer-minus-three': {
      lives: {},
      copies: 0,
      events: { damage: 1, sbaCreatureDies: 1 },
    },
    'pr10-sarkhan-the-dragonspeaker-viewer-emblem': {
      lives: {},
      copies: 0,
      events: { createEmblem: 1 },
    },
    'pr10-mirage-mirror-viewer-becomes-copy': { lives: {}, copies: 0, events: { becomeCopy: 1 } },
    'pr10-mirage-mirror-viewer-insufficient-cost': {
      lives: {},
      copies: 0,
      absent: 'Mirage Mirror:',
      events: { becomeCopy: 0 },
    },
    'pr10-saheeli-sublime-artificer-viewer-servo': {
      lives: { P2: 39 },
      copies: 0,
      events: { tokenCreated: 1 },
    },
    'pr10-saheeli-sublime-artificer-viewer-minus-two': {
      lives: {},
      copies: 0,
      events: { becomeCopy: 1 },
    },
    'pr10-scute-swarm-viewer-insect': { lives: {}, copies: 0, events: { tokenCreated: 1 } },
    'pr10-scute-swarm-viewer-copy': { lives: {}, copies: 0, events: { tokenCreated: 1 } },
    'pr10-council-of-reeds-viewer-legend-rule': {
      lives: {},
      copies: 0,
      events: { sbaLegendRule: 0, castSpell: 1 },
    },
    'pr10-council-of-reeds-viewer-combat-copy': {
      lives: {},
      copies: 0,
      events: { tokenCreated: 1 },
    },
    'pr10-council-of-reeds-viewer-combat-no-copy': {
      lives: {},
      copies: 0,
      events: { tokenCreated: 0 },
    },
    'pr10-twilight-diviner-viewer-surveil': { lives: {}, copies: 0, events: { surveil: 1 } },
    'pr10-twilight-diviner-viewer-from-graveyard': {
      lives: {},
      copies: 0,
      events: { tokenCreated: 1, graveyardToBattlefield: 1 },
    },
    'pr10-twilight-diviner-viewer-from-hand': {
      lives: {},
      copies: 0,
      events: { tokenCreated: 0 },
    },
    'pr10-saheeli-radiant-creator-viewer-energy': { lives: {}, copies: 0, events: { energy: 1 } },
    'pr10-saheeli-radiant-creator-viewer-combat-copy': {
      lives: {},
      copies: 0,
      events: { tokenCreated: 1, energy: 1 },
    },
    'pr10-saheeli-radiant-creator-viewer-not-enough-energy': {
      lives: {},
      copies: 0,
      events: { tokenCreated: 0, energy: 0 },
    },
    'pr10-saheeli-radiant-creator-viewer-decline': {
      lives: {},
      copies: 0,
      events: { tokenCreated: 0, energy: 0 },
    },
    'pr10-mocking-doppelganger-viewer-copy': { lives: {}, copies: 0, events: { becomeCopy: 1 } },
    'pr10-mocking-doppelganger-viewer-decline': {
      lives: {},
      copies: 0,
      events: { becomeCopy: 0, sbaCreatureDies: 1 },
    },
    'pr10-duplicant-viewer-exile': { lives: {}, copies: 0, events: { exile: 1 } },
    'pr10-duplicant-viewer-decline': { lives: {}, copies: 0, events: { exile: 0 } },
    'pr10-nighthawk-scavenger-viewer-empty': { lives: {}, copies: 0 },
    'pr10-nighthawk-scavenger-viewer-counts-types': { lives: { P3: 38 }, copies: 0 },
    'pr10-nighthawk-scavenger-viewer-own-graveyard': { lives: { P2: 39 }, copies: 0 },
    'pr10-xenagos-god-of-revels-viewer-low-devotion': { lives: {}, copies: 0 },
    'pr10-xenagos-god-of-revels-viewer-seven-devotion': { lives: {}, copies: 0 },
    'pr10-xenagos-god-of-revels-viewer-combat': {
      lives: {},
      copies: 0,
      events: { grantKeyword: 1, pump: 1 },
    },
    'pr10-trazyn-the-infinite-viewer-activated': {
      lives: { P1: 42 },
      copies: 0,
      events: { activateAbility: 1 },
    },
    'pr10-trazyn-the-infinite-viewer-mana': {
      lives: { P2: 39 },
      copies: 0,
      events: { castSpell: 1 },
    },
    'pr10-trazyn-the-infinite-viewer-scope': {
      lives: {},
      copies: 0,
      absent: 'Trazyn the Infinite:',
    },
    'pr10-reality-shift-viewer-manifest': { lives: {}, copies: 0, events: { exile: 1 } },
    'pr10-reality-shift-viewer-turn-face-up': {
      lives: {},
      copies: 0,
      events: { exile: 1, turnedFaceUp: 1 },
    },
    'pr10-dragon-man-reformed-robot-viewer-power': { lives: {}, copies: 0 },
    'pr10-dragon-man-reformed-robot-viewer-excludes': { lives: {}, copies: 0 },
    'pr10-dragon-man-reformed-robot-viewer-graveyard-cast': {
      lives: {},
      copies: 0,
      events: { discard: 1 },
    },
    'pr10-rowan-kenrith-viewer-plus-two': {
      lives: {},
      copies: 0,
      events: { attackRequirement: 1 },
    },
    'pr10-rowan-kenrith-viewer-minus-two': { lives: {}, copies: 0, events: { damageEach: 1 } },
    'pr10-rowan-kenrith-viewer-emblem': { lives: {}, copies: 0, events: { createEmblem: 1 } },
    'pr10-rowan-kenrith-viewer-partner': { lives: {}, copies: 0, events: { castSpell: 1 } },
    'pr10-rowan-kenrith-viewer-commander': { lives: {}, copies: 0, events: { castSpell: 1 } },
    'pr10-biotransference-viewer-artifact-spell': {
      lives: { P1: 39 },
      copies: 0,
      events: { tokenCreated: 1, lifeLoss: 1 },
    },
    'pr10-biotransference-viewer-noncreature-spell': {
      lives: { P1: 40, P2: 39 },
      copies: 0,
      events: { tokenCreated: 0 },
    },
    'pr10-biotransference-viewer-opponents-spell': {
      lives: { P1: 40 },
      copies: 0,
      events: { tokenCreated: 0 },
    },
  };

  it('has expectations for every scenario', () => {
    expect(Object.keys(EXPECTATIONS).sort()).toEqual(PR10_SCENARIOS.map(({ id }) => id).sort());
  });

  it.each(PR10_SCENARIOS)('$id plays through the production cast and stack path', ({ id }) => {
    const result = run(id);
    const plan = PLANS[id]!;
    const expected = EXPECTATIONS[id]!;
    const log = result.state.eventLog;
    expect(log.some((event) => event.type === 'engineHalt')).toBe(false);
    expect(result.casts).toEqual(plan.casts.map((entry) => entry.name));
    for (const [seat, life] of Object.entries(expected.lives)) {
      expect(result.state.players.find((player) => player.id === seat)!.life, seat).toBe(life);
    }
    expect(log.filter((event) => event.type === 'spellCopied')).toHaveLength(expected.copies);
    for (const [type, count] of Object.entries(expected.events ?? {}))
      expect(
        log.filter((event) => event.type === type),
        type,
      ).toHaveLength(count);
    for (const description of expected.present ?? [])
      expect(result.offered, description).toContain(description);
    if (expected.absent !== undefined)
      expect(
        [...result.offered].filter((description) => description.startsWith(expected.absent!)),
      ).toEqual([]);
  });

  it('retargets the same object for Swat, and never copies it', () => {
    const result = run('pr10-deflecting-swat-viewer-positive');
    const log = result.state.eventLog;
    expect(
      log.filter((event) => event.type === 'resolved').map((event) => event.payload['description']),
    ).toEqual(expect.arrayContaining(['Deflecting Swat', 'PR10 Lab Shock']));
    expect(log.some((event) => event.type === 'spellCopied')).toBe(false);
  });

  it('Bolt Bend never offers the current target as the new one', () => {
    const result = run('pr10-bolt-bend-viewer-positive');
    expect(result.offered).not.toContain('Keep P3 as the target');
    expect(result.offered).not.toContain('Target P3');
    expect(result.offered).toContain('Target P4');
  });

  it('Cosmic Crucible adds exactly four mana before any spell is cast', () => {
    const result = run('pr10-cosmic-crucible-viewer-mana');
    expect(result.options).toEqual([
      'Distribute 4 mana (allowed: {R} and the other listed colors)',
    ]);
    const added = result.state.eventLog.filter((event) => event.type === 'manaAdded');
    expect(added.length).toBeGreaterThan(0);
  });

  it('Cosmic Crucible copies only the first noncreature spell of the turn', () => {
    const result = run('pr10-cosmic-crucible-viewer-once-each-turn');
    const copied = result.state.eventLog.filter((event) => event.type === 'spellCopied');
    expect(copied.map((event) => event.payload['name'])).toEqual(['PR10 Lab Shock']);
    // The second trigger still goes on the stack, but offers no copy of PR10 Lab Zap.
    expect(result.offered).not.toContain('Copy PR10 Lab Zap');
  });

  it('Galvanic Iteration is exiled by flashback and its delayed trigger lasts the turn', () => {
    const result = run('pr10-galvanic-iteration-viewer-flashback');
    expect(result.state.exile.some((card) => card.name === 'Galvanic Iteration')).toBe(true);
    const p1 = result.state.players.find((player) => player.id === 'P1')!;
    expect(p1.graveyard.some((card) => card.name === 'Galvanic Iteration')).toBe(false);
  });

  it('Flare of Duplication sacrifices the nontoken red creature', () => {
    const result = run('pr10-flare-of-duplication-viewer-sacrifice');
    const p1 = result.state.players.find((player) => player.id === 'P1')!;
    expect(p1.graveyard.some((card) => card.name === 'PR10 Lab Red Bear')).toBe(true);
    expect(result.state.battlefield.some((card) => card.name === 'PR10 Lab Red Bear')).toBe(false);
  });
  it('Siren Stormtamer is sacrificed to counter the spell aimed at you', () => {
    const result = run('pr10-siren-stormtamer-viewer-counter-spell');
    const p1 = result.state.players.find((player) => player.id === 'P1')!;
    expect(p1.graveyard.some((card) => card.name === 'Siren Stormtamer')).toBe(true);
    expect(result.state.battlefield.some((card) => card.name === 'Siren Stormtamer')).toBe(false);
    const p2 = result.state.players.find((player) => player.id === 'P2')!;
    expect(p2.graveyard.some((card) => card.name === 'PR10 Lab Shock')).toBe(true);
  });

  it('Mana Sculpt adds the mana spent only with a Wizard, at the next main phase', () => {
    const wizard = run('pr10-mana-sculpt-viewer-wizard');
    const added = wizard.state.eventLog.filter((event) => event.type === 'manaAdded');
    expect(added.map((event) => event.payload['symbols'])).toEqual([['C', 'C']]);
    const begun = wizard.state.eventLog.filter((event) => event.type === 'phaseBegin');
    expect(begun.at(-1)!.payload['phase']).toBe('postcombatMain');
  });

  it('Mister Fantastic copies are separate abilities with their own targets', () => {
    const result = run('pr10-mister-fantastic-viewer-copy-twice');
    const damage = result.state.eventLog.filter((event) => event.type === 'damage');
    expect(damage.map((event) => event.payload['target']).sort()).toEqual(['P2', 'P3', 'P4']);
  });

  it('Verrak copies the ability only when the life is paid again', () => {
    const paid = run('pr10-verrak-warped-sengir-viewer-pay-again');
    const draws = paid.state.eventLog.filter((event) => event.type === 'draw');
    expect(draws).toHaveLength(2);
    const copy = run('pr10-verrak-warped-sengir-viewer-new-target');
    const hits = copy.state.eventLog.filter((event) => event.type === 'damage');
    expect(hits.map((event) => event.payload['target']).sort()).toEqual(['P2', 'P3']);
  });
  it('Annie Joins Up destroys only the opponent creature it targets', () => {
    const result = run('pr10-annie-joins-up-viewer-enter-damage');
    expect(result.state.battlefield.some((card) => card.name === 'PR10 Lab Brute')).toBe(false);
    expect(result.state.battlefield.some((card) => card.name === 'PR10 Lab Bear')).toBe(true);
  });
  const onBattlefield = (result: ReturnType<typeof run>, name: string) =>
    result.scenario.engine
      .view('P1')
      .battlefield.filter((card) => card.name === name && card.controller === 'P1');

  it('Atarka Monument is a 4/4 flyer once animated, and taps for red', () => {
    const [dragon] = onBattlefield(run('pr10-atarka-monument-viewer-animate'), 'Atarka Monument');
    expect([dragon!.power, dragon!.toughness]).toEqual([4, 4]);
    expect(dragon!.keywords).toContain('flying');
    const [tapped] = onBattlefield(run('pr10-atarka-monument-viewer-mana'), 'Atarka Monument');
    expect(tapped!.tapped).toBe(true);
    const [plain] = onBattlefield(
      run('pr10-atarka-monument-viewer-insufficient-cost'),
      'Atarka Monument',
    );
    expect(plain!.power ?? null).toBeNull();
  });

  it('Sarkhan becomes a 4/4 flying indestructible haste creature, and the -3 kills the target', () => {
    const [sarkhan] = onBattlefield(
      run('pr10-sarkhan-the-dragonspeaker-viewer-plus-one'),
      'Sarkhan, the Dragonspeaker',
    );
    expect([sarkhan!.power, sarkhan!.toughness]).toEqual([4, 4]);
    expect(sarkhan!.keywords).toEqual(
      expect.arrayContaining(['flying', 'indestructible', 'haste']),
    );
    const walked = run('pr10-sarkhan-the-dragonspeaker-viewer-minus-three');
    expect(walked.state.battlefield.some((card) => card.name === 'PR10 Lab Brute')).toBe(false);
  });

  it('Mirage Mirror and Saheeli copy a permanent without leaving a second object', () => {
    const [mirror] = onBattlefield(run('pr10-mirage-mirror-viewer-becomes-copy'), 'PR10 Lab Brute');
    expect([mirror!.power, mirror!.toughness]).toEqual([4, 4]);
    const trinket = onBattlefield(
      run('pr10-saheeli-sublime-artificer-viewer-minus-two'),
      'PR10 Lab Bear',
    );
    expect(trinket).toHaveLength(2);
    const [servo] = onBattlefield(run('pr10-saheeli-sublime-artificer-viewer-servo'), 'Servo');
    expect([servo!.power, servo!.toughness]).toEqual([1, 1]);
  });
  it('Scute Swarm makes an Insect below six lands and a copy of itself from six', () => {
    const insect = run('pr10-scute-swarm-viewer-insect');
    const [bug] = onBattlefield(insect, 'Insect');
    expect([bug!.power, bug!.toughness]).toEqual([1, 1]);
    expect(onBattlefield(insect, 'Scute Swarm')).toHaveLength(1);
    expect(onBattlefield(run('pr10-scute-swarm-viewer-copy'), 'Scute Swarm')).toHaveLength(2);
    expect(onBattlefield(run('pr10-scute-swarm-viewer-copy'), 'Insect')).toHaveLength(0);
  });

  it('Council of Reeds keeps both legends and copies itself only after a noncreature spell', () => {
    expect(
      onBattlefield(run('pr10-council-of-reeds-viewer-legend-rule'), 'PR10 Lab Commander'),
    ).toHaveLength(2);
    expect(
      onBattlefield(run('pr10-council-of-reeds-viewer-combat-copy'), 'Council of Reeds'),
    ).toHaveLength(2);
    expect(
      onBattlefield(run('pr10-council-of-reeds-viewer-combat-no-copy'), 'Council of Reeds'),
    ).toHaveLength(1);
  });

  it('Twilight Diviner surveils into the graveyard, and copies only a graveyard arrival', () => {
    const surveil = run('pr10-twilight-diviner-viewer-surveil');
    const p1 = surveil.state.players.find((player) => player.id === 'P1')!;
    expect(p1.graveyard.some((card) => card.name === 'PR10 Lab Bear')).toBe(true);
    expect(
      onBattlefield(run('pr10-twilight-diviner-viewer-from-graveyard'), 'PR10 Lab Bear'),
    ).toHaveLength(2);
    expect(
      onBattlefield(run('pr10-twilight-diviner-viewer-from-hand'), 'PR10 Lab Bear'),
    ).toHaveLength(1);
  });

  it('Saheeli, Radiant Creator copies a permanent as a hasty 5/5 only when the energy is paid', () => {
    const paid = onBattlefield(
      run('pr10-saheeli-radiant-creator-viewer-combat-copy'),
      'PR10 Lab Brute',
    );
    expect(paid).toHaveLength(2);
    expect(paid.map((card) => [card.power, card.toughness]).sort()).toEqual([
      [4, 4],
      [5, 5],
    ]);
    for (const id of ['not-enough-energy', 'decline'])
      expect(
        onBattlefield(run(`pr10-saheeli-radiant-creator-viewer-${id}`), 'PR10 Lab Brute'),
      ).toHaveLength(1);
  });

  it('Mocking Doppelganger enters as a copy of the opponent creature, or as itself', () => {
    const [copy] = onBattlefield(run('pr10-mocking-doppelganger-viewer-copy'), 'PR10 Lab Brute');
    expect([copy!.power, copy!.toughness]).toEqual([4, 4]);
    expect(
      onBattlefield(run('pr10-mocking-doppelganger-viewer-decline'), 'Mocking Doppelganger'),
    ).toHaveLength(0);
  });
  const size = (card: { power?: number | null; toughness?: number | null }) => [
    card.power,
    card.toughness,
  ];

  it('Duplicant takes the exiled creature’s power, toughness and types, or stays a 2/4', () => {
    const [taken] = onBattlefield(run('pr10-duplicant-viewer-exile'), 'Duplicant');
    expect(size(taken!)).toEqual([4, 4]);
    expect(
      run('pr10-duplicant-viewer-exile').state.battlefield.some(
        (card) => card.name === 'PR10 Lab Brute',
      ),
    ).toBe(false);
    const [kept] = onBattlefield(run('pr10-duplicant-viewer-decline'), 'Duplicant');
    expect(size(kept!)).toEqual([2, 4]);
  });

  it('Nighthawk Scavenger counts only card types in opponents’ graveyards', () => {
    const [empty] = onBattlefield(
      run('pr10-nighthawk-scavenger-viewer-empty'),
      'Nighthawk Scavenger',
    );
    expect(size(empty!)).toEqual([1, 3]);
    expect(empty!.keywords).toEqual(expect.arrayContaining(['flying', 'deathtouch', 'lifelink']));
    const [counted] = onBattlefield(
      run('pr10-nighthawk-scavenger-viewer-counts-types'),
      'Nighthawk Scavenger',
    );
    expect(size(counted!)).toEqual([2, 3]);
    const [own] = onBattlefield(
      run('pr10-nighthawk-scavenger-viewer-own-graveyard'),
      'Nighthawk Scavenger',
    );
    expect(size(own!)).toEqual([1, 3]);
  });

  it('Xenagos is a creature only at seven devotion to red and green', () => {
    const [low] = onBattlefield(
      run('pr10-xenagos-god-of-revels-viewer-low-devotion'),
      'Xenagos, God of Revels',
    );
    expect(low!.power ?? null).toBeNull();
    const [high] = onBattlefield(
      run('pr10-xenagos-god-of-revels-viewer-seven-devotion'),
      'Xenagos, God of Revels',
    );
    expect(size(high!)).toEqual([6, 5]);
    expect(high!.keywords).toContain('indestructible');
  });

  it('Trazyn gains only the abilities of artifact cards in your graveyard', () => {
    const activated = run('pr10-trazyn-the-infinite-viewer-activated');
    expect(activated.offered).toContain('Trazyn the Infinite: {1}: You gain 2 life.');
    const scoped = run('pr10-trazyn-the-infinite-viewer-scope');
    expect(scoped.offered).toContain('Cast PR10 Lab Zap ({R})');
  });

  it('Reality Shift exiles, manifests, and lets a manifested creature card turn face up', () => {
    const shifted = run('pr10-reality-shift-viewer-manifest');
    expect(shifted.state.battlefield.some((card) => card.name === 'PR10 Lab Brute')).toBe(false);
    expect(shifted.state.battlefield.filter((card) => card.controllerId === 'P3')).toHaveLength(1);
    const [up] = onBattlefield(run('pr10-reality-shift-viewer-turn-face-up'), 'PR10 Lab Red Bear');
    expect(size(up!)).toEqual([2, 2]);
  });

  it('Dragon Man reads the greatest noncreature mana value and casts from the graveyard', () => {
    const [power] = onBattlefield(
      run('pr10-dragon-man-reformed-robot-viewer-power'),
      'Dragon Man, Reformed Robot',
    );
    expect(size(power!)).toEqual([4, 5]);
    const [excluded] = onBattlefield(
      run('pr10-dragon-man-reformed-robot-viewer-excludes'),
      'Dragon Man, Reformed Robot',
    );
    expect(size(excluded!)).toEqual([0, 5]);
    const cast = run('pr10-dragon-man-reformed-robot-viewer-graveyard-cast');
    expect(onBattlefield(cast, 'Dragon Man, Reformed Robot')).toHaveLength(1);
    const p1 = cast.state.players.find((player) => player.id === 'P1')!;
    expect(p1.graveyard.some((card) => card.name === 'PR10 Lab Zap')).toBe(true);
  });

  it('Rowan Kenrith loses two loyalty for the -2, and is cast from the command zone as a commander', () => {
    const minus = run('pr10-rowan-kenrith-viewer-minus-two');
    expect(onBattlefield(minus, 'Rowan Kenrith')).toHaveLength(1);
    const commander = run('pr10-rowan-kenrith-viewer-commander');
    expect(onBattlefield(commander, 'Rowan Kenrith')).toHaveLength(1);
  });

  it('Biotransference makes a Necron Warrior only for your own artifact spells', () => {
    const own = run('pr10-biotransference-viewer-artifact-spell');
    expect(onBattlefield(own, 'Necron Warrior')).toHaveLength(1);
    expect(
      onBattlefield(run('pr10-biotransference-viewer-noncreature-spell'), 'Necron Warrior'),
    ).toHaveLength(0);
  });
});
