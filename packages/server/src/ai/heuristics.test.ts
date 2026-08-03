import { describe, expect, it } from 'vitest';
import type { DecisionRequest, LegalAction, PlayerView } from '@mtg/shared';
import { tryHeuristic } from './heuristics';

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

  it.each(['beginCombat', 'endCombat'] as const)(
    'applies at the inert combat step %s',
    (step) => {
      const req = makeRequest({ phase: 'combat', step, legalActions: [PASS, INSTANT] });

      expect(tryHeuristic(req, makeView())?.actionId).toBe(0);
    },
  );

  it.each(['declareAttackers', 'declareBlockers', 'combatDamage', 'firstStrikeCombatDamage'] as const)(
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

describe('tryHeuristic — declining a powerless attack', () => {
  const attackRequest = (power: number, hasTriggers = false): DecisionRequest =>
    makeRequest({
      decisionType: 'declareAttackers',
      phase: 'combat',
      step: 'declareAttackers',
      activePlayer: 'P1',
      legalActions: [
        {
          id: 0,
          type: 'noAttack',
          description: 'Kobolds of Kher Keep does not attack',
          data: { power, toughness: 1, hasTriggers },
        },
        {
          id: 1,
          type: 'attack',
          description: 'Kobolds of Kher Keep attacks P2 (40 life)',
          data: { power, toughness: 1, hasTriggers },
        },
      ],
    });

  it('declines the attack for a 0-power creature', () => {
    const res = tryHeuristic(attackRequest(0), makeView());

    expect(res?.actionId).toBe(0);
    expect(res?.note).toContain('no combat damage');
  });

  it('declines the attack for a negative-power creature', () => {
    expect(tryHeuristic(attackRequest(-1), makeView())?.actionId).toBe(0);
  });

  it('asks the model about a creature that can actually deal damage', () => {
    expect(tryHeuristic(attackRequest(3), makeView())).toBeNull();
  });

  it('asks the model when power is unknown', () => {
    const req = makeRequest({
      decisionType: 'declareAttackers',
      legalActions: [{ id: 0, type: 'noAttack', description: 'X does not attack' }],
    });

    expect(tryHeuristic(req, makeView())).toBeNull();
  });

  it('asks the model when the attacker has a triggered ability', () => {
    expect(tryHeuristic(attackRequest(0, true), makeView())).toBeNull();
  });

  it('asks the model when hasTriggers is absent, rather than assuming none', () => {
    const req = makeRequest({
      decisionType: 'declareAttackers',
      legalActions: [
        { id: 0, type: 'noAttack', description: 'X does not attack', data: { power: 0 } },
      ],
    });

    expect(tryHeuristic(req, makeView())).toBeNull();
  });

  it('still declines when an instant is held but cannot be cast', () => {
    const view = makeView({
      hand: [{ id: 'c1', name: 'Brute Strength', typeLine: 'Instant' }],
    });

    expect(tryHeuristic(attackRequest(0), view)?.actionId).toBe(0);
  });

  it('asks the model when a castable instant could make the attack worthwhile', () => {
    const req = attackRequest(0);
    req.legalActions.push({
      id: 2,
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

    expect(tryHeuristic(attackRequest(0), view)?.actionId).toBe(0);
  });

  it('declines for the whole group at once when every undeclared creature is powerless', () => {
    const req = makeRequest({
      decisionType: 'declareAttackers',
      legalActions: [
        { id: 0, type: 'noAttack', description: 'X does not attack', data: { power: 0, hasTriggers: false } },
        { id: 1, type: 'attack', description: 'X attacks P2', data: { power: 0, hasTriggers: false } },
        {
          id: 2,
          type: 'noAttackRest',
          description: 'No further attacks: X and the 2 other undeclared creature(s) all stay home',
          data: { count: 3, maxPower: 0, hasTriggers: false },
        },
      ],
    });
    const res = tryHeuristic(req, makeView());

    // The batch answer, not the single-creature one — this ends the step in one call.
    expect(res?.actionId).toBe(2);
    expect(res?.note).toContain('all 3 undeclared creatures');
  });

  it('falls back to declining just this creature when a later one can deal damage', () => {
    const req = makeRequest({
      decisionType: 'declareAttackers',
      legalActions: [
        { id: 0, type: 'noAttack', description: 'X does not attack', data: { power: 0, hasTriggers: false } },
        {
          id: 2,
          type: 'noAttackRest',
          description: 'No further attacks',
          data: { count: 3, maxPower: 4, hasTriggers: false },
        },
      ],
    });

    expect(tryHeuristic(req, makeView())?.actionId).toBe(0);
  });

  it('asks the model when any creature in the group has a triggered ability', () => {
    const req = makeRequest({
      decisionType: 'declareAttackers',
      legalActions: [
        { id: 0, type: 'noAttack', description: 'X does not attack', data: { power: 0, hasTriggers: true } },
        {
          id: 2,
          type: 'noAttackRest',
          description: 'No further attacks',
          data: { count: 3, maxPower: 0, hasTriggers: true },
        },
      ],
    });

    expect(tryHeuristic(req, makeView())).toBeNull();
  });

  it('leaves the no-blocks-at-all shortcut to the model', () => {
    const req = makeRequest({
      decisionType: 'declareBlockers',
      legalActions: [
        { id: 0, type: 'noBlock', description: 'X does not block' },
        { id: 1, type: 'block', description: 'X blocks Y' },
        { id: 2, type: 'noBlockRest', description: 'No blocks at all' },
      ],
    });

    expect(tryHeuristic(req, makeView())).toBeNull();
  });

  it('leaves block declarations alone', () => {
    const req = makeRequest({
      decisionType: 'declareBlockers',
      legalActions: [
        { id: 0, type: 'noBlock', description: 'X does not block', data: { power: 0 } },
        { id: 1, type: 'block', description: 'X blocks Y', data: { power: 0 } },
      ],
    });

    expect(tryHeuristic(req, makeView())).toBeNull();
  });
});
