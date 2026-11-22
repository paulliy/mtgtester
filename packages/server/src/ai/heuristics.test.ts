import { describe, expect, it } from 'vitest';
import type { DecisionRequest, LegalAction, PermanentView, PlayerView } from '@mtg/shared';
import {
  abilityFactsFrom,
  tryHeuristic,
  type AbilityFacts,
  type AbilityFactsLookup,
} from './heuristics';

function makeView(overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    seat: 'P1',
    life: 40,
    hand: [],
    deck: [],
    graveyard: [],
    exile: [],
    commanders: [],
    availableMana: {},
    manaSources: [],
    opponents: [],
    battlefield: [],
    stack: [],
    recentLog: [],
    ...overrides,
  };
}

function makeRequest(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    requestId: 'req-1',
    gameId: 'g1',
    turn: 8,
    activePlayer: 'P2',
    decidingPlayer: 'P1',
    phase: 'beginning',
    step: 'upkeep',
    decisionType: 'priority',
    prompt: 'You have priority.',
    legalActions: [],
    ...overrides,
  };
}

const PASS: LegalAction = { id: 0, type: 'pass', description: 'Pass priority' };
const INSTANT: LegalAction = {
  id: 1,
  type: 'castSpell',
  description: "Cast Predator's Strike ({1}{G})",
  data: { instantSpeed: true },
};

describe('tryHeuristic — deferring instants', () => {
  it('passes when the only alternatives are instants and the stack is empty', () => {
    const res = tryHeuristic(makeRequest({ legalActions: [PASS, INSTANT] }), makeView());

    expect(res?.actionId).toBe(0);
    expect(res?.note).toContain('Heuristic');
  });

  it('applies in the ending phase too', () => {
    const req = makeRequest({ phase: 'ending', step: 'end', legalActions: [PASS, INSTANT] });

    expect(tryHeuristic(req, makeView())?.actionId).toBe(0);
  });

  it('defers to the model when something is on the stack to respond to', () => {
    const view = makeView({
      stack: [{ id: 'o1', controller: 'P2', description: 'Lightning Bolt', targets: ['P1'] }],
    });

    expect(tryHeuristic(makeRequest({ legalActions: [PASS, INSTANT] }), view)).toBeNull();
  });

  it('applies in main phases, where an all-instants menu means there is no line to miss', () => {
    const req = makeRequest({ phase: 'precombatMain', step: null, legalActions: [PASS, INSTANT] });

    expect(tryHeuristic(req, makeView())?.actionId).toBe(0);
  });

  it.each(['beginCombat', 'endCombat'] as const)('applies at the inert combat step %s', (step) => {
    const req = makeRequest({ phase: 'combat', step, legalActions: [PASS, INSTANT] });

    expect(tryHeuristic(req, makeView())?.actionId).toBe(0);
  });

  it.each([
    'declareAttackers',
    'declareBlockers',
    'combatDamage',
    'firstStrikeCombatDamage',
  ] as const)(
    'defers to the model at combat step %s, where a trick changes the outcome',
    (step) => {
      const req = makeRequest({ phase: 'combat', step, legalActions: [PASS, INSTANT] });

      expect(tryHeuristic(req, makeView())).toBeNull();
    },
  );

  it('defers to the model when a sorcery-speed option is also on the menu', () => {
    const sorcery: LegalAction = {
      id: 2,
      type: 'castSpell',
      description: 'Cast Tor Giant ({3}{R})',
      data: { instantSpeed: false },
    };
    const req = makeRequest({ legalActions: [PASS, INSTANT, sorcery] });

    expect(tryHeuristic(req, makeView())).toBeNull();
  });

  it('defers to the model when an option carries no instantSpeed marker', () => {
    const unmarked: LegalAction = { id: 1, type: 'castSpell', description: 'Cast Something' };
    const req = makeRequest({ legalActions: [PASS, unmarked] });

    expect(tryHeuristic(req, makeView())).toBeNull();
  });

  it('does not fire when pass is the only option (the engine already forced it)', () => {
    expect(tryHeuristic(makeRequest({ legalActions: [PASS] }), makeView())).toBeNull();
  });
});

describe('tryHeuristic — taking the land drop', () => {
  const land: LegalAction = { id: 1, type: 'playLand', description: 'Play Forest' };

  it('plays the land when it is the only alternative to passing', () => {
    const req = makeRequest({
      phase: 'precombatMain',
      step: null,
      legalActions: [PASS, land],
    });
    const res = tryHeuristic(req, makeView());

    expect(res?.actionId).toBe(1);
    expect(res?.note).toContain('land drop');
  });

  it('asks the model which land to play when there is a choice of lands', () => {
    const req = makeRequest({
      phase: 'precombatMain',
      step: null,
      legalActions: [PASS, land, { id: 2, type: 'playLand', description: 'Play Island' }],
    });

    expect(tryHeuristic(req, makeView())).toBeNull();
  });

  it('asks the model when a spell could be cast instead, since sequencing matters', () => {
    const req = makeRequest({
      phase: 'precombatMain',
      step: null,
      legalActions: [
        PASS,
        land,
        { id: 2, type: 'castSpell', description: 'Cast Tor Giant', data: { instantSpeed: false } },
      ],
    });

    expect(tryHeuristic(req, makeView())).toBeNull();
  });
});

describe('tryHeuristic — declining a powerless attack (ADR 0023 items 13/14 batched shape)', () => {
  /** One `attackDeclaration` action naming however many subjects `powers` describes. */
  const attackRequest = (
    powers: number[],
    opts: { hasTriggers?: boolean[]; mustAttack?: boolean[] } = {},
  ): DecisionRequest =>
    makeRequest({
      decisionType: 'declareAttackers',
      phase: 'combat',
      step: 'declareAttackers',
      activePlayer: 'P1',
      legalActions: [
        {
          id: 0,
          type: 'attackDeclaration',
          description: `Declare attackers (${powers.length} eligible creature(s))`,
          data: {
            subjects: powers.map((power, i) => ({
              subjectId: `c${i}`,
              power,
              toughness: 1,
              hasTriggers: opts.hasTriggers?.[i] ?? false,
              mustAttack: opts.mustAttack?.[i] ?? false,
            })),
          },
          targets: powers.map((_, i) => ({ slot: i, options: ['P2', '__no_attack__'] })),
        },
      ],
    });

  it('declines the whole attack when the only eligible creature has 0 power', () => {
    const res = tryHeuristic(attackRequest([0]), makeView());

    expect(res?.actionId).toBe(0);
    expect(res?.targets).toEqual([{ slot: 0, choice: '__no_attack__' }]);
    expect(res?.note).toContain('no combat damage');
  });

  it('declines for a negative-power creature too', () => {
    expect(tryHeuristic(attackRequest([-1]), makeView())?.actionId).toBe(0);
  });

  it('asks the model about a creature that can actually deal damage', () => {
    expect(tryHeuristic(attackRequest([3]), makeView())).toBeNull();
  });

  it('declines for the whole group at once when every eligible creature is powerless', () => {
    const res = tryHeuristic(attackRequest([0, 0, 0]), makeView());

    expect(res?.actionId).toBe(0);
    expect(res?.targets).toEqual([
      { slot: 0, choice: '__no_attack__' },
      { slot: 1, choice: '__no_attack__' },
      { slot: 2, choice: '__no_attack__' },
    ]);
    expect(res?.note).toContain('all 3 eligible creature');
  });

  it('asks the model when the board is mixed — one real attacker among powerless ones', () => {
    expect(tryHeuristic(attackRequest([0, 4, 0]), makeView())).toBeNull();
  });

  it('asks the model when any creature in the group has a triggered ability', () => {
    expect(
      tryHeuristic(attackRequest([0, 0], { hasTriggers: [false, true] }), makeView()),
    ).toBeNull();
  });

  it('asks the model when any creature is goad-mandatory (CR 508.1d — NO_ATTACK_TARGET would be illegal for it)', () => {
    expect(
      tryHeuristic(attackRequest([0, 0], { mustAttack: [false, true] }), makeView()),
    ).toBeNull();
  });

  it('still declines when an instant is held but cannot be cast', () => {
    const view = makeView({
      hand: [{ id: 'c1', name: 'Brute Strength', typeLine: 'Instant' }],
    });

    expect(tryHeuristic(attackRequest([0]), view)?.actionId).toBe(0);
  });

  it('asks the model when a castable instant could make the attack worthwhile', () => {
    const req = attackRequest([0]);
    req.legalActions.push({
      id: 1,
      type: 'castSpell',
      description: 'Cast Brute Strength ({R})',
      data: { instantSpeed: true },
    });

    expect(tryHeuristic(req, makeView())).toBeNull();
  });

  it('still fires when the hand holds only sorcery-speed cards', () => {
    const view = makeView({
      hand: [{ id: 'c1', name: 'Tor Giant', typeLine: 'Creature — Giant Warrior' }],
    });

    expect(tryHeuristic(attackRequest([0]), view)?.actionId).toBe(0);
  });

  it('leaves block declarations alone (ADR 0023 Phase 4 batched shape) — a judgment call, no heuristic exists', () => {
    const req = makeRequest({
      decisionType: 'declareBlockers',
      legalActions: [
        {
          id: 0,
          type: 'blockDeclaration',
          description: 'Declare blockers (1 eligible creature(s))',
          data: { subjects: [{ subjectId: 'c0', power: 0, toughness: 4, mustBlock: false }] },
          targets: [{ slot: 0, options: ['a0', '__no_block__'] }],
        },
      ],
    });

    expect(tryHeuristic(req, makeView())).toBeNull();
  });
});

describe('tryHeuristic — Rule D, deferring quiet abilities before the opponent acts', () => {
  const ABILITY: LegalAction = {
    id: 2,
    type: 'activateAbility',
    description:
      'Zopandrel, Hunger Dominus: Put an indestructible counter on Zopandrel, Hunger Dominus.',
    interaction: { kind: 'source', sourceId: 'z1', abilityIndex: 0 },
    data: { sourceName: 'Zopandrel, Hunger Dominus' },
  };
  const YIELD: LegalAction = { id: 9, type: 'passAndYieldTurn', description: 'Pass and yield' };
  const facts =
    (value: AbilityFacts | undefined): AbilityFactsLookup =>
    () =>
      value;
  const quiet = facts({ roles: [], targets: [] });
  const req = (overrides: Partial<DecisionRequest> = {}): DecisionRequest =>
    makeRequest({ legalActions: [PASS, ABILITY, YIELD], ...overrides });

  it.each(['upkeep', 'draw'] as const)(
    "passes (without yielding) in an opponent's %s with an empty stack",
    (step) => {
      const res = tryHeuristic(req({ step }), makeView(), quiet);
      expect(res?.actionId).toBe(0);
      expect(res?.note).toContain('Heuristic');
    },
  );

  it('also covers a menu mixing the ability with instants', () => {
    const res = tryHeuristic(req({ legalActions: [PASS, ABILITY, INSTANT] }), makeView(), quiet);
    expect(res?.actionId).toBe(0);
  });

  it('accepts friendly and non-hostile roles', () => {
    const lookup = facts({ roles: ['draw', 'protection'], targets: ['friendly'] });
    expect(tryHeuristic(req(), makeView(), lookup)?.actionId).toBe(0);
  });

  it('does nothing without a facts lookup, so callers that cannot describe abilities are unchanged', () => {
    expect(tryHeuristic(req(), makeView())).toBeNull();
  });

  it('asks the model when the ability is unknown to the card-traits table', () => {
    expect(tryHeuristic(req(), makeView(), facts(undefined))).toBeNull();
  });

  it.each([
    ['a hostile target slot', { roles: [], targets: ['hostile'] }],
    ['a removal role', { roles: ['removal'], targets: [] }],
    ['a burn role', { roles: ['burn'], targets: [] }],
    ['a counter role', { roles: ['counter'], targets: [] }],
  ] as const)('asks the model for an ability with %s', (_label, value) => {
    expect(tryHeuristic(req(), makeView(), facts(value))).toBeNull();
  });

  it('asks the model on its own turn', () => {
    expect(tryHeuristic(req({ activePlayer: 'P1' }), makeView(), quiet)).toBeNull();
  });

  it.each([
    ['precombatMain', null],
    ['combat', 'beginCombat'],
    ['ending', 'end'],
  ] as const)('asks the model in %s / %s', (phase, step) => {
    expect(tryHeuristic(req({ phase, step }), makeView(), quiet)).toBeNull();
  });

  it('asks the model when something is on the stack', () => {
    const view = makeView({
      stack: [{ id: 'o1', controller: 'P2', description: 'Wrath of God', targets: [] }],
    });
    expect(tryHeuristic(req(), view, quiet)).toBeNull();
  });

  it('asks the model when a sorcery-speed or other non-instant option is on the menu', () => {
    const land: LegalAction = { id: 3, type: 'playLand', description: 'Play Forest' };
    expect(
      tryHeuristic(req({ legalActions: [PASS, ABILITY, land] }), makeView(), quiet),
    ).toBeNull();
  });

  it('leaves mana abilities alone', () => {
    const mana: LegalAction = { ...ABILITY, data: { ...ABILITY.data, producesMana: true } };
    expect(tryHeuristic(req({ legalActions: [PASS, mana] }), makeView(), quiet)).toBeNull();
  });
});

describe('abilityFactsFrom', () => {
  const action: LegalAction = {
    id: 2,
    type: 'activateAbility',
    description: 'x',
    interaction: { kind: 'source', sourceId: 'p1', abilityIndex: 1 },
  };
  const view = makeView({
    battlefield: [{ id: 'p1', name: 'Shadowspear', controller: 'P1' } as PermanentView],
  });

  it('reads the roles and targets of the ability by index, naming the source from the view', () => {
    const lookup = abilityFactsFrom((name) =>
      name === 'Shadowspear'
        ? ({ abilityRoles: [[], ['pump']], abilityTargets: [[], ['friendly']] } as never)
        : undefined,
    );
    expect(lookup(action, view)).toEqual({ roles: ['pump'], targets: ['friendly'] });
  });

  it('is undefined for an unknown card or ability index', () => {
    expect(abilityFactsFrom(() => undefined)(action, view)).toBeUndefined();
    expect(
      abilityFactsFrom(() => ({ abilityRoles: [[]], abilityTargets: [[]] }) as never)(action, view),
    ).toBeUndefined();
  });
});
