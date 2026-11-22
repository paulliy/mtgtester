import { describe, expect, it } from 'vitest';
import type {
  BotSteering,
  CardView,
  DecisionRequest,
  LegalAction,
  PermanentView,
  PlayerView,
} from '@mtg/shared';
import { NO_ATTACK_TARGET } from '@mtg/shared';
import type { CardKnowledge, CardTraits } from './card-knowledge';
import { decide, decideScored, evaluate } from './evaluate';
import type { PolicyFix } from './fixes';
import { manaValueOfCost } from './policy';
import { Rng } from './rng';

function view(overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    seat: 'P1',
    life: 40,
    hand: [],
    deck: [],
    graveyard: [],
    exile: [],
    availableMana: {},
    manaSources: [],
    commanders: [],
    battlefield: [],
    stack: [],
    recentLog: [],
    opponents: [
      {
        seat: 'P2',
        life: 40,
        handSize: 5,
        librarySize: 80,
        graveyard: [],
        commanders: [],
        poisonCounters: 0,
        commanderDamageDealtToYou: 0,
      },
      {
        seat: 'P3',
        life: 40,
        handSize: 5,
        librarySize: 80,
        graveyard: [],
        commanders: [],
        poisonCounters: 0,
        commanderDamageDealtToYou: 0,
      },
    ],
    ...overrides,
  } as PlayerView;
}

function request(
  legalActions: LegalAction[],
  overrides: Partial<DecisionRequest> = {},
): DecisionRequest {
  return {
    requestId: 'r1',
    gameId: 'g',
    turn: 3,
    activePlayer: 'P1',
    decidingPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    decisionType: 'priority',
    prompt: '',
    legalActions,
    ...overrides,
  };
}

function creature(
  id: string,
  controller: string,
  power: number,
  toughness: number,
  extra: Partial<PermanentView> = {},
): PermanentView {
  return {
    id,
    controller,
    name: `Creature ${id}`,
    typeLine: 'Creature — Bear',
    power,
    toughness,
    keywords: [],
    tapped: false,
    status: [],
    ...extra,
  };
}

function land(id: string, controller = 'P1'): PermanentView {
  return {
    id,
    controller,
    name: 'Forest',
    typeLine: 'Basic Land — Forest',
    tapped: false,
    status: [],
  };
}

function card(id: string, name: string, typeLine: string, manaCost?: string): CardView {
  return { id, name, typeLine, ...(manaCost === undefined ? {} : { manaCost }) };
}

const PASS: LegalAction = { id: 0, type: 'pass', description: 'Pass priority' };

function knowledge(table: Record<string, Partial<CardTraits>>): CardKnowledge {
  return (name) => {
    const t = table[name];
    return t === undefined ? undefined : { manaValue: 0, types: [], roles: [], ...t };
  };
}

describe('manaValueOfCost', () => {
  it('counts generic, colored and hybrid symbols, and X as 0', () => {
    expect(manaValueOfCost('{2}{G}{G}')).toBe(4);
    expect(manaValueOfCost('{X}{R}')).toBe(1);
    expect(manaValueOfCost('{W/U}{1}')).toBe(2);
    expect(manaValueOfCost(undefined)).toBe(0);
  });
});

describe('mulligan and bottoming', () => {
  const keep: LegalAction = { id: 0, type: 'keep', description: 'Keep this hand' };
  const mull: LegalAction = { id: 1, type: 'mulligan', description: 'Mulligan' };
  const hand = (lands: number): CardView[] =>
    Array.from({ length: 7 }, (_, i) =>
      i < lands
        ? card(`h${i}`, 'Forest', 'Basic Land — Forest')
        : card(`h${i}`, 'Bear', 'Creature — Bear', '{1}{G}'),
    );

  it('keeps three lands and mulligans zero or seven', () => {
    const req = request([keep, mull], { decisionType: 'mulligan' });
    expect(decide(req, view({ hand: hand(3) }), new Rng('a')).actionId).toBe(0);
    expect(decide(req, view({ hand: hand(0) }), new Rng('a')).actionId).toBe(1);
    expect(decide(req, view({ hand: hand(7) }), new Rng('a')).actionId).toBe(1);
  });

  it('stops mulliganing a one-lander after two mulligans', () => {
    const req = request([keep, mull], { decisionType: 'mulligan' });
    expect(decide(req, view({ hand: hand(1) }), new Rng('a')).actionId).toBe(1);
    expect(decide(req, view({ hand: hand(1) }), new Rng('a'), { mulligansTaken: 2 }).actionId).toBe(
      0,
    );
  });

  it('bottoms a land from a land-heavy hand and the priciest spell otherwise', () => {
    const cards = [
      card('a', 'Forest', 'Basic Land — Forest'),
      card('b', 'Forest', 'Basic Land — Forest'),
      card('c', 'Forest', 'Basic Land — Forest'),
      card('d', 'Forest', 'Basic Land — Forest'),
      card('e', 'Big', 'Creature — Giant', '{6}{G}'),
      card('f', 'Small', 'Creature — Elf', '{G}'),
    ];
    const actions = cards.map((c, i): LegalAction => ({
      id: i,
      type: 'bottomCard',
      description: `Bottom ${c.name}`,
      interaction: { kind: 'choice', subjectId: c.id } as unknown as NonNullable<
        LegalAction['interaction']
      >,
    }));
    const req = request(actions, { decisionType: 'bottomCards' });
    const landHeavy = decide(req, view({ hand: cards }), new Rng('a'));
    expect(cards[landHeavy.actionId]!.typeLine).toContain('Land');

    const spellHeavy = [
      cards[0]!,
      cards[1]!,
      cards[4]!,
      cards[5]!,
      card('g', 'Mid', 'Sorcery', '{3}'),
    ];
    const actions2 = spellHeavy.map((c, i): LegalAction => ({
      id: i,
      type: 'bottomCard',
      description: `Bottom ${c.name}`,
      interaction: { kind: 'choice', subjectId: c.id } as unknown as NonNullable<
        LegalAction['interaction']
      >,
    }));
    const chosen = decide(
      request(actions2, { decisionType: 'bottomCards' }),
      view({ hand: spellHeavy }),
      new Rng('a'),
    );
    expect(spellHeavy[chosen.actionId]!.name).toBe('Big');
  });

  it('accepts an optional trigger', () => {
    const req = request(
      [
        { id: 0, type: 'acceptTrigger', description: 'Yes' },
        { id: 1, type: 'declineTrigger', description: 'No' },
      ],
      { decisionType: 'optionalTrigger' },
    );
    expect(decide(req, view(), new Rng('a')).actionId).toBe(0);
  });
});

describe('card-aware priority scoring', () => {
  it('plays the land before a spell and the bigger spell before the smaller', () => {
    const actions: LegalAction[] = [
      PASS,
      {
        id: 1,
        type: 'castSpell',
        description: 'Cast Bear',
        data: { sourceName: 'Bear', manaCost: '{1}{G}' },
      },
      {
        id: 2,
        type: 'castSpell',
        description: 'Cast Giant',
        data: { sourceName: 'Giant', manaCost: '{4}{G}' },
      },
      { id: 3, type: 'playLand', description: 'Play Forest' },
    ];
    const ranked = evaluate(request(actions), view());
    expect(ranked.map((r) => r.action.id)).toEqual([3, 2, 1, 0]);
  });

  it('never casts a counterspell into an empty stack, and casts it at an opposing spell', () => {
    const counter: LegalAction = {
      id: 1,
      type: 'castSpell',
      description: 'Cast Counterspell',
      targets: [{ slot: 0, options: ['s1'] }],
      data: { sourceName: 'Counterspell', manaCost: '{U}{U}', instantSpeed: true },
    };
    const k = knowledge({
      Counterspell: { manaValue: 2, roles: ['counter'], spellTargets: ['hostile'] },
    });
    const idle = decide(request([PASS, counter]), view(), new Rng('a'), { knowledge: k });
    expect(idle.actionId).toBe(0);
    const facing = view({
      stack: [{ id: 's1', controller: 'P2', description: 'Cast Giant', targets: [] }],
    });
    expect(decide(request([PASS, counter]), facing, new Rng('a'), { knowledge: k }).actionId).toBe(
      1,
    );
  });

  it("aims removal at the opponent's best creature, never its own", () => {
    const board = [
      creature('mine', 'P1', 5, 5),
      creature('small', 'P2', 1, 1),
      creature('big', 'P3', 6, 6),
    ];
    const removal: LegalAction = {
      id: 1,
      type: 'castSpell',
      description: 'Cast Murder',
      targets: [{ slot: 0, options: ['mine', 'small', 'big'] }],
      data: { sourceName: 'Murder', manaCost: '{1}{B}{B}' },
    };
    const k = knowledge({
      Murder: { manaValue: 3, roles: ['removal'], spellTargets: ['hostile'] },
    });
    const res = decide(request([PASS, removal]), view({ battlefield: board }), new Rng('a'), {
      knowledge: k,
    });
    expect(res.actionId).toBe(1);
    expect(res.targets).toEqual([{ slot: 0, choice: 'big' }]);
  });

  it('bolts a creature it can kill over a bigger one it cannot', () => {
    const board = [creature('small', 'P2', 2, 2), creature('huge', 'P2', 10, 10)];
    const bolt: LegalAction = {
      id: 1,
      type: 'castSpell',
      description: 'Cast Lightning Bolt',
      instantSpeed: true,
      targets: [{ slot: 0, options: ['huge', 'small'] }],
      data: { sourceName: 'Lightning Bolt', manaCost: '{R}', instantSpeed: true },
    } as LegalAction;
    const k = knowledge({
      'Lightning Bolt': {
        manaValue: 1,
        roles: ['removal'],
        spellTargets: ['hostile'],
        spellDamage: [3],
      },
    });
    const res = decide(request([PASS, bolt]), view({ battlefield: board }), new Rng('a'), {
      knowledge: k,
    });
    expect(res.targets).toEqual([{ slot: 0, choice: 'small' }]);
  });

  it('values a selective wipe by the creatures it actually destroys', () => {
    // Their Name Is Death: "Destroy all nonartifact creatures."
    const golems = [1, 2, 3, 4, 5].map((n) =>
      creature(`golem${n}`, 'P1', 4, 4, { typeLine: 'Artifact Creature — Golem' }),
    );
    const board = [...golems, creature('theirs', 'P2', 5, 5)];
    const wipe: LegalAction = {
      id: 1,
      type: 'castSpell',
      description: 'Cast Their Name Is Death',
      data: { sourceName: 'Their Name Is Death', manaCost: '{4}{B}{B}' },
    };
    const selector = {
      kind: 'allOf',
      of: [
        { kind: 'type', value: 'Creature' },
        { kind: 'not', of: { kind: 'type', value: 'Artifact' } },
      ],
    };
    const traits = { manaValue: 6, roles: ['wipe'] as const, wipeSelector: selector };
    const res = decide(request([PASS, wipe]), view({ battlefield: board }), new Rng('a'), {
      knowledge: knowledge({ 'Their Name Is Death': traits }),
    });
    expect(res.actionId).toBe(1);
    // Without the selector the same board reads as a five-for-one loss.
    const blind = decide(request([PASS, wipe]), view({ battlefield: board }), new Rng('a'), {
      knowledge: knowledge({ 'Their Name Is Death': { manaValue: 6, roles: ['wipe'] } }),
    });
    expect(blind.actionId).toBe(0);
  });

  it('reads polarity by slot number when a mode leaves earlier slots out', () => {
    // Boros Charm's double-strike mode offers only slot 1; slot 0 is the hostile damage mode.
    const board = [creature('mine', 'P1', 3, 3), creature('theirs', 'P2', 5, 5)];
    const charm: LegalAction = {
      id: 1,
      type: 'castSpell',
      description: 'Cast Boros Charm',
      targets: [{ slot: 1, options: ['theirs', 'mine'] }],
      data: { sourceName: 'Boros Charm', manaCost: '{R}{W}', instantSpeed: true },
    };
    const k = knowledge({
      'Boros Charm': { manaValue: 2, roles: [], spellTargets: ['hostile', 'friendly'] },
    });
    const res = decide(request([charm]), view({ battlefield: board }), new Rng('a'), {
      knowledge: k,
    });
    expect(res.targets).toEqual([{ slot: 1, choice: 'mine' }]);
  });

  it('still aims removal by polarity when diplomacy is on but no deal applies', () => {
    const board = [creature('mine', 'P1', 5, 5), creature('theirs', 'P2', 3, 3)];
    const removal: LegalAction = {
      id: 1,
      type: 'castSpell',
      description: 'Cast Murder',
      targets: [{ slot: 0, options: ['mine', 'theirs'] }],
      data: { sourceName: 'Murder', manaCost: '{1}{B}{B}' },
    };
    const k = knowledge({
      Murder: { manaValue: 3, roles: ['removal'], spellTargets: ['hostile'] },
    });
    const res = decide(request([PASS, removal]), view({ battlefield: board }), new Rng('a'), {
      knowledge: k,
      diplomacy: { obligations: () => [], startingOpponents: 3 },
    });
    expect(res.targets).toEqual([{ slot: 0, choice: 'theirs' }]);
  });

  it('does not cast removal whose only targets are its own permanents', () => {
    const removal: LegalAction = {
      id: 1,
      type: 'castSpell',
      description: 'Cast Murder',
      targets: [{ slot: 0, options: ['mine'] }],
      data: { sourceName: 'Murder', manaCost: '{1}{B}{B}' },
    };
    const k = knowledge({
      Murder: { manaValue: 3, roles: ['removal'], spellTargets: ['hostile'] },
    });
    const res = decide(
      request([PASS, removal]),
      view({ battlefield: [creature('mine', 'P1', 3, 3)] }),
      new Rng('a'),
      { knowledge: k },
    );
    expect(res.actionId).toBe(0);
  });

  it('pumps its own creature', () => {
    const pump: LegalAction = {
      id: 1,
      type: 'castSpell',
      description: 'Cast Giant Growth',
      targets: [{ slot: 0, options: ['theirs', 'mine'] }],
      data: { sourceName: 'Giant Growth', manaCost: '{G}', instantSpeed: true },
    };
    const k = knowledge({
      'Giant Growth': { manaValue: 1, roles: ['pump'], spellTargets: ['friendly'] },
    });
    const board = [creature('theirs', 'P2', 4, 4), creature('mine', 'P1', 2, 2)];
    const res = decide(
      request([PASS, pump], { phase: 'combat', step: 'declareBlockers' }),
      view({ battlefield: board }),
      new Rng('a'),
      { knowledge: k },
    );
    expect(res.targets).toEqual([{ slot: 0, choice: 'mine' }]);
  });

  it('holds a pump spell outside combat with nothing on the stack', () => {
    const pump: LegalAction = {
      id: 1,
      type: 'castSpell',
      description: 'Cast Giant Growth',
      targets: [{ slot: 0, options: ['mine'] }],
      data: { sourceName: 'Giant Growth', manaCost: '{G}', instantSpeed: true },
    };
    const k = knowledge({
      'Giant Growth': { manaValue: 1, roles: ['pump'], spellTargets: ['friendly'] },
    });
    const res = decide(
      request([PASS, pump]),
      view({ battlefield: [creature('mine', 'P1', 2, 2)] }),
      new Rng('a'),
      { knowledge: k },
    );
    expect(res.actionId).toBe(0);
  });

  it('casts a sorcery-speed pump in its main phase', () => {
    const overrun: LegalAction = {
      id: 1,
      type: 'castSpell',
      description: 'Cast Overrun',
      data: { sourceName: 'Overrun', manaCost: '{2}{G}{G}{G}', instantSpeed: false },
    };
    const k = knowledge({ Overrun: { manaValue: 5, roles: ['pump'] } });
    const res = decide(
      request([PASS, overrun]),
      view({ battlefield: [creature('mine', 'P1', 2, 2)] }),
      new Rng('a'),
      { knowledge: k },
    );
    expect(res.actionId).toBe(1);
  });

  it('picks different objects for two slots when it can', () => {
    const copy: LegalAction = {
      id: 1,
      type: 'activateAbility',
      description: 'Target artifact you control becomes a copy of another target artifact',
      targets: [
        { slot: 0, options: ['a1', 'a2'] },
        { slot: 1, options: ['a1', 'a2', 'a3'] },
      ],
    };
    const res = decide(request([copy]), view(), new Rng('a'));
    const [first, second] = res.targets!;
    expect(first!.choice).not.toBe(second!.choice);
  });

  it('reuses an opposing target rather than aim a hostile slot at its own permanent', () => {
    // Hull Breach's artifact-and-enchantment mode: one object may fill both slots (CR 115.3).
    const board = [creature('theirs', 'P2', 3, 3), creature('mine', 'P1', 3, 3)];
    const breach: LegalAction = {
      id: 1,
      type: 'castSpell',
      description: 'Cast Hull Breach',
      targets: [
        { slot: 0, options: ['theirs', 'mine'] },
        { slot: 1, options: ['theirs', 'mine'] },
      ],
      data: { sourceName: 'Hull Breach', manaCost: '{R}{G}' },
    };
    const k = knowledge({
      'Hull Breach': { manaValue: 2, roles: ['removal'], spellTargets: ['hostile', 'hostile'] },
    });
    const res = decide(request([PASS, breach]), view({ battlefield: board }), new Rng('a'), {
      knowledge: k,
    });
    expect(res.targets!.map((t) => t.choice)).toEqual(['theirs', 'theirs']);
  });

  it("does not score a modal card's non-counter mode as an idle counterspell", () => {
    const draw: LegalAction = {
      id: 1,
      type: 'castSpell',
      description: 'Cast Mystic Confluence — draw a card',
      data: {
        sourceName: 'Mystic Confluence',
        manaCost: '{3}{U}{U}',
        instantSpeed: true,
        modeLabel: 'Draw a card. ×3',
      },
    };
    const k = knowledge({
      'Mystic Confluence': { manaValue: 5, roles: ['counter', 'draw'], spellTargets: ['hostile'] },
    });
    const ranked = evaluate(request([PASS, draw]), view(), { knowledge: k });
    const score = ranked.find((r) => r.action.id === 1)!.score;
    expect(score).toBeGreaterThan(-5);
  });

  it('uses a sorcery-speed pump ability in its main phase', () => {
    const minus: LegalAction = {
      id: 1,
      type: 'activateAbility',
      description: 'Ajani: −3: creatures gain flying and double strike',
      data: {
        sourceName: 'Ajani',
        abilityDescription: '−3: creatures gain flying and double strike',
      },
      interaction: { kind: 'source', sourceId: 'ajani', sourceCardId: 'c-a', abilityIndex: 0 },
    };
    const k = knowledge({
      Ajani: {
        manaValue: 3,
        roles: [],
        abilityRoles: [['pump']],
        abilitySorcery: [true],
      },
    });
    const res = decide(
      request([PASS, minus]),
      view({ battlefield: [creature('mine', 'P1', 2, 2)] }),
      new Rng('a'),
      { knowledge: k },
    );
    expect(res.actionId).toBe(1);
  });

  it('does not float mana by activating a mana ability on its own', () => {
    // The engine's manual mana action shape (packages/engine/src/mana/manual.ts).
    const tap: LegalAction = {
      id: 1,
      type: 'activateManaAbility',
      description: 'Tap Forest for G',
      data: { symbols: ['G'] },
    };
    expect(decide(request([PASS, tap]), view(), new Rng('a')).actionId).toBe(0);
  });
});

describe('steering', () => {
  const spell = (id: number, name: string, cost: string): LegalAction => ({
    id,
    type: 'castSpell',
    description: `Cast ${name}`,
    data: { sourceName: name, manaCost: cost },
  });

  it('casts a prioritized card first and keeps a held card in hand', () => {
    const actions = [PASS, spell(1, 'Big', '{5}'), spell(2, 'Small', '{1}')];
    const steer: BotSteering = { prioritize: ['small'], hold: ['Big'] };
    const ranked = evaluate(request(actions), view(), { steering: steer });
    expect(ranked[0]!.action.id).toBe(2);
    expect(ranked.at(-1)!.action.id).toBe(1);
  });

  // Holding mana up needs something to hold it for: a cheap counterspell in hand, and a mana base
  // big enough that keeping two open still leaves a three-drop castable (five sources).
  const counterspell = card('cs', 'Counterspell', 'Instant', '{U}{U}');
  const holdKnowledge = knowledge({
    Counterspell: { manaValue: 2, types: ['Instant'], roles: ['counter'] },
    'Ambush Viper': { manaValue: 2, types: ['Creature'], flash: true, power: 2 },
    'Dissolve Late': { manaValue: 4, types: ['Instant'], roles: ['counter'] },
  });
  const lands = (n: number) => Array.from({ length: n }, (_, i) => land(`l${i}`));
  const holding = (extra: Partial<PlayerView> = {}) =>
    view({ hand: [counterspell], battlefield: lands(5), ...extra });

  it('leaves mana up when asked to hold it', () => {
    const actions = [PASS, spell(1, 'Sorcery', '{3}')];
    const sources = [1, 2, 3].map((n) => ({ name: `Forest ${n}`, symbols: ['G'], count: 1 }));
    const res = decide(request(actions), holding({ manaSources: sources }), new Rng('a'), {
      knowledge: holdKnowledge,
      steering: { holdUpMana: 2 },
    });
    expect(res.actionId).toBe(0);
  });

  it('holds nothing up when it holds no instant-speed interaction', () => {
    const actions = [PASS, spell(1, 'Sorcery', '{3}')];
    const sources = [1, 2, 3].map((n) => ({ name: `Forest ${n}`, symbols: ['G'], count: 1 }));
    const res = decide(
      request(actions),
      holding({ hand: [], manaSources: sources }),
      new Rng('a'),
      { knowledge: holdKnowledge, steering: { holdUpMana: 2 } },
    );
    expect(res.actionId).toBe(1);
  });

  it('never holds back early plays: a one-drop on turn one, a three-drop on turn three', () => {
    const one = decide(
      request([PASS, spell(1, 'Bear Cub', '{G}')]),
      holding({
        battlefield: lands(1),
        manaSources: [{ name: 'Forest', symbols: ['G'], count: 1 }],
      }),
      new Rng('a'),
      { knowledge: holdKnowledge, steering: { holdUpMana: 2 } },
    );
    expect(one.actionId).toBe(1);
    const three = decide(
      request([PASS, spell(1, 'Three Drop', '{2}{G}')]),
      holding({
        battlefield: lands(3),
        manaSources: [1, 2, 3].map((n) => ({ name: `Forest ${n}`, symbols: ['G'], count: 1 })),
      }),
      new Rng('a'),
      { knowledge: holdKnowledge, steering: { holdUpMana: 2 } },
    );
    expect(three.actionId).toBe(1);
  });

  it('holds up for a flash creature, but not for interaction dearer than three', () => {
    const actions = [PASS, spell(1, 'Sorcery', '{3}')];
    const sources = [1, 2, 3].map((n) => ({ name: `Forest ${n}`, symbols: ['G'], count: 1 }));
    const answer = (hand: CardView[]) =>
      decide(request(actions), holding({ hand, manaSources: sources }), new Rng('a'), {
        knowledge: holdKnowledge,
        steering: { holdUpMana: 2 },
      }).actionId;
    expect(answer([card('av', 'Ambush Viper', 'Creature — Snake', '{1}{G}')])).toBe(0);
    expect(answer([card('dl', 'Dissolve Late', 'Instant', '{3}{U}')])).toBe(1);
  });

  it('never holds up against casting the commander, or from a hand that would discard', () => {
    const sources = [1, 2, 3].map((n) => ({ name: `Forest ${n}`, symbols: ['G'], count: 1 }));
    const fromCommand: LegalAction = {
      ...spell(1, 'Sorcery', '{3}'),
      data: { sourceName: 'Sorcery', manaCost: '{3}', sourceZone: 'command' },
    };
    const commander = decide(
      request([PASS, fromCommand]),
      holding({ manaSources: sources }),
      new Rng('a'),
      { knowledge: holdKnowledge, steering: { holdUpMana: 2 } },
    );
    expect(commander.actionId).toBe(1);
    const fullHand = Array.from({ length: 6 }, (_, i) =>
      card(`x${i}`, `Filler ${i}`, 'Sorcery', '{5}'),
    );
    const full = decide(
      request([PASS, spell(1, 'Sorcery', '{3}')]),
      holding({ hand: [counterspell, ...fullHand], manaSources: sources }),
      new Rng('a'),
      { knowledge: holdKnowledge, steering: { holdUpMana: 2 } },
    );
    expect(full.actionId).toBe(1);
  });

  it('counts grouped sources once toward held mana', () => {
    // The view folds untapped sources into availableMana too; they must not count twice.
    const actions = [PASS, spell(1, 'Sorcery', '{3}')];
    const forests = [1, 2, 3].map((n) => ({ name: `Forest ${n}`, symbols: ['G'], count: 1 }));
    const held = decide(
      request(actions),
      holding({ manaSources: forests, availableMana: { G: 3 } }),
      new Rng('a'),
      { knowledge: holdKnowledge, steering: { holdUpMana: 2 } },
    );
    expect(held.actionId).toBe(0);
    // One row that makes five (a grouped or multi-mana source) leaves two up after {3}.
    const grouped = decide(
      request(actions),
      holding({
        manaSources: [{ name: 'Forest', symbols: ['G'], count: 5 }],
        availableMana: { G: 5 },
      }),
      new Rng('a'),
      { knowledge: holdKnowledge, steering: { holdUpMana: 2 } },
    );
    expect(grouped.actionId).toBe(1);
  });

  it('counts a multi-ability land like Aether Hub as one mana for hold-up', () => {
    const actions = [PASS, spell(1, 'Sorcery', '{2}')];
    const sources = [
      { name: 'Aether Hub', symbols: ['C', 'W', 'U', 'B', 'R', 'G'], count: 2 },
      { name: 'Forest', symbols: ['G'], count: 2 },
    ];
    const res = decide(request(actions), holding({ manaSources: sources }), new Rng('a'), {
      knowledge: holdKnowledge,
      steering: { holdUpMana: 2 },
    });
    expect(res.actionId).toBe(0);
  });

  it('holds up mana by the cost actually paid, so a free spell keeps it all', () => {
    // Frogmite reduced to {0} by affinity: its printed value of 4 must not trip hold-up.
    const actions = [PASS, spell(1, 'Frogmite', '{0}')];
    const forests = [1, 2].map((n) => ({ name: `Forest ${n}`, symbols: ['G'], count: 1 }));
    const k = knowledge({ Frogmite: { manaValue: 4, types: ['Artifact', 'Creature'], power: 2 } });
    const res = decide(request(actions), view({ manaSources: forests }), new Rng('a'), {
      knowledge: k,
      steering: { holdUpMana: 2 },
    });
    expect(res.actionId).toBe(1);
  });

  function attack(
    subjects: Array<{ id: string; power: number; toughness: number; hasTriggers?: boolean }>,
  ): LegalAction {
    return {
      id: 0,
      type: 'attackDeclaration',
      description: 'Declare attackers',
      targets: subjects.map((_, i) => ({ slot: i, options: [NO_ATTACK_TARGET, 'P2', 'P3'] })),
      data: {
        subjects: subjects.map((s) => ({
          subjectId: s.id,
          power: s.power,
          toughness: s.toughness,
          mustAttack: false,
          hasTriggers: s.hasTriggers ?? false,
          defenders: ['P2', 'P3'],
          planeswalkers: [],
        })),
      },
    };
  }

  it('attacks the steered target and stays home at aggression 0', () => {
    const board = [creature('c1', 'P1', 3, 3), land('l1', 'P2')];
    const req = request([attack([{ id: 'c1', power: 3, toughness: 3 }])], {
      decisionType: 'declareAttackers',
      phase: 'combat',
      step: 'declareAttackers',
    });
    const toP3 = decide(req, view({ battlefield: board }), new Rng('a'), {
      steering: { targetOrder: ['P3'] },
    });
    expect(toP3.targets).toEqual([{ slot: 0, choice: 'P3' }]);
    const home = decide(req, view({ battlefield: board }), new Rng('a'), {
      steering: { aggression: 0 },
    });
    expect(home.targets).toEqual([{ slot: 0, choice: NO_ATTACK_TARGET }]);
    // Diplomacy with no deals in force leaves the steered attack policy in charge.
    const homeAtTable = decide(req, view({ battlefield: board }), new Rng('a'), {
      steering: { aggression: 0 },
      diplomacy: { obligations: () => [], startingOpponents: 2 },
    });
    expect(homeAtTable.targets).toEqual([{ slot: 0, choice: NO_ATTACK_TARGET }]);
  });

  it('only swings into a bad block when aggression is high', () => {
    const board = [
      creature('c1', 'P1', 2, 2),
      creature('c2', 'P1', 2, 2),
      creature('wall', 'P2', 4, 6),
      creature('wall2', 'P3', 4, 6),
    ];
    const req = request([attack([{ id: 'c1', power: 2, toughness: 2 }])], {
      decisionType: 'declareAttackers',
      phase: 'combat',
      step: 'declareAttackers',
    });
    const normal = decide(req, view({ battlefield: board }), new Rng('a'));
    expect(normal.targets).toEqual([{ slot: 0, choice: NO_ATTACK_TARGET }]);
    const raging = decide(req, view({ battlefield: board }), new Rng('a'), {
      steering: { aggression: 1 },
    });
    expect(raging.targets![0]!.choice).not.toBe(NO_ATTACK_TARGET);
  });

  it('a risky attack needs a reason: a lone creature or a 1-power body without a trigger stays home', () => {
    const walls = [creature('wall', 'P2', 4, 6), creature('wall2', 'P3', 4, 6)];
    const swing = (
      board: PermanentView[],
      subject: { id: string; power: number; toughness: number; hasTriggers?: boolean },
    ) =>
      decide(
        request([attack([subject])], {
          decisionType: 'declareAttackers',
          phase: 'combat',
          step: 'declareAttackers',
        }),
        view({ battlefield: [...board, ...walls] }),
        new Rng('a'),
        { steering: { aggression: 1 } },
      ).targets![0]!.choice;
    const pair = [creature('c1', 'P1', 1, 1), creature('c2', 'P1', 2, 2)];
    expect(swing([creature('c1', 'P1', 2, 2)], { id: 'c1', power: 2, toughness: 2 })).toBe(
      NO_ATTACK_TARGET,
    );
    expect(swing(pair, { id: 'c1', power: 1, toughness: 1 })).toBe(NO_ATTACK_TARGET);
    expect(swing(pair, { id: 'c1', power: 1, toughness: 1, hasTriggers: true })).not.toBe(
      NO_ATTACK_TARGET,
    );
  });
});

describe('last answer and face damage', () => {
  const counter: LegalAction = {
    id: 1,
    type: 'castSpell',
    description: 'Cast Counterspell',
    interaction: { kind: 'source', sourceId: 'c1' },
    targets: [{ slot: 0, options: ['s1'] }],
    data: { sourceName: 'Counterspell', manaCost: '{U}{U}', instantSpeed: true },
  };
  const k = knowledge({
    Counterspell: { manaValue: 2, roles: ['counter'], spellTargets: ['hostile'] },
    'Mind Stone': { manaValue: 2, types: ['Artifact'], roles: ['ramp'] },
    'Wrath of God': { manaValue: 4, types: ['Sorcery'], roles: ['wipe'] },
    Shock: {
      manaValue: 1,
      roles: ['burn', 'removal'],
      spellTargets: ['hostile'],
      spellDamage: [2],
    },
  });
  const facing = (spell: string, extra: Partial<PlayerView> = {}): PlayerView =>
    view({
      hand: [card('c1', 'Counterspell', 'Instant', '{U}{U}')],
      stack: [{ id: 's1', controller: 'P2', description: spell, targets: [] }],
      ...extra,
    });
  const answer = (v: PlayerView, steering?: BotSteering) =>
    decide(request([PASS, counter], { activePlayer: 'P2' }), v, new Rng('a'), {
      knowledge: k,
      ...(steering !== undefined && { steering }),
    }).actionId;

  it('keeps the only counterspell from a two-mana rock and spends it on a wipe', () => {
    expect(answer(facing('Mind Stone'))).toBe(0);
    expect(answer(facing('Wrath of God'))).toBe(1);
  });

  it('spends it on the rock when another counterspell backs it up', () => {
    const backed = facing('Mind Stone', {
      hand: [
        card('c1', 'Counterspell', 'Instant', '{U}{U}'),
        card('c2', 'Counterspell', 'Instant', '{U}{U}'),
      ],
    });
    expect(answer(backed)).toBe(1);
  });

  it('spends it when the strategist prioritizes the card', () => {
    expect(answer(facing('Mind Stone'), { prioritize: ['Counterspell'] })).toBe(1);
  });

  it('spends it when lethal is on the public board', () => {
    const dying = facing('Mind Stone', { life: 5, battlefield: [creature('x', 'P2', 6, 6)] });
    expect(answer(dying)).toBe(1);
  });

  it('spends it on the rock without the scarceAnswer fix, as the bot did before', () => {
    const res = decide(
      request([PASS, counter], { activePlayer: 'P2' }),
      facing('Mind Stone'),
      new Rng('a'),
      {
        knowledge: k,
        fixes: [],
      },
    );
    expect(res.actionId).toBe(1);
  });

  it('burns a creature it kills rather than two points at a healthy player, but finishes a low one', () => {
    const shock: LegalAction = {
      id: 1,
      type: 'castSpell',
      description: 'Cast Shock',
      targets: [{ slot: 0, options: ['P2', 'lions'] }],
      data: { sourceName: 'Shock', manaCost: '{R}', instantSpeed: true },
    };
    const board = [creature('lions', 'P3', 2, 1)];
    const aim = (p2Life: number) =>
      decide(
        request([PASS, shock]),
        view({
          battlefield: board,
          opponents: view().opponents.map((o) => (o.seat === 'P2' ? { ...o, life: p2Life } : o)),
        }),
        new Rng('a'),
        { knowledge: k },
      ).targets;
    expect(aim(30)).toEqual([{ slot: 0, choice: 'lions' }]);
    expect(aim(2)).toEqual([{ slot: 0, choice: 'P2' }]);
  });

  it('kills a player in reach before scaling damage at another one, even for an aggro seat', () => {
    // An aggro seat scales damage to a player it does not kill (1.5x style, high aggression); a
    // kill must still outrank five points at the opponent on 6 life.
    const grenadeKnowledge = knowledge({
      'Test Grenade': {
        manaValue: 1,
        roles: ['burn'],
        spellTargets: ['hostile'],
        spellDamage: [5],
      },
    });
    const grenade: LegalAction = {
      id: 1,
      type: 'castSpell',
      description: 'Cast Test Grenade',
      targets: [{ slot: 0, options: ['P3', 'P2'] }],
      data: { sourceName: 'Test Grenade', manaCost: '{R}' },
    };
    const lives: Record<string, number> = { P2: 5, P3: 6 };
    const table = view({
      opponents: view().opponents.map((o) => ({ ...o, life: lives[o.seat] ?? o.life })),
    });
    const aim = (steering?: BotSteering) =>
      decide(request([PASS, grenade]), table, new Rng('a'), {
        knowledge: grenadeKnowledge,
        ...(steering !== undefined && { steering }),
      }).targets;
    expect(aim({ style: 'aggro', aggression: 0.85 })).toEqual([{ slot: 0, choice: 'P2' }]);
    expect(aim({ style: 'aggro', aggression: 1 })).toEqual([{ slot: 0, choice: 'P2' }]);
    expect(aim()).toEqual([{ slot: 0, choice: 'P2' }]);
  });
});

describe('decideScored', () => {
  it('returns the ranking behind the answer', () => {
    const actions = [PASS, { id: 1, type: 'playLand', description: 'Play Forest' }];
    const scored = decideScored(request(actions), view(), new Rng('a'));
    expect(scored.response.actionId).toBe(1);
    expect(scored.ranked.map((r) => r.action.id)).toEqual([1, 0]);
  });

  it('keeps the legacy scoring available for comparison', () => {
    const actions = [
      PASS,
      { id: 1, type: 'castSpell', description: 'Cast Bear', data: { manaCost: '{1}{G}' } },
      { id: 2, type: 'castSpell', description: 'Cast Giant', data: { manaCost: '{6}{G}' } },
    ];
    const ranked = evaluate(request(actions), view(), { legacy: true });
    expect(ranked[0]!.score).toBe(ranked[1]!.score);
  });
});

describe('another target', () => {
  it('never picks an "another target" action with one object for two slots', () => {
    const copy: LegalAction = {
      id: 1,
      type: 'activateAbility',
      description: 'Target artifact you control becomes a copy of another target artifact',
      targets: [
        { slot: 0, options: ['a1'] },
        { slot: 1, options: ['a1'] },
      ],
    };
    expect(decide(request([PASS, copy]), view(), new Rng('a')).actionId).toBe(0);
  });
});

describe('activations with no effect role', () => {
  const counter: LegalAction = {
    id: 1,
    type: 'activateAbility',
    description: 'Mutagen: put a counter',
    targets: [{ slot: 0, options: ['theirs', 'mine'] }],
    data: {
      sourceName: 'Mutagen',
      abilityDescription:
        '{1}, {T}, Sacrifice this token: Put a +1/+1 counter on target creature. Activate only as a sorcery.',
    },
    interaction: { kind: 'source', sourceId: 'mutagen', sourceCardId: 'c-m', abilityIndex: 0 },
  };

  it('reads target polarity from the effect, not from a sacrifice in the cost', () => {
    const board = [creature('theirs', 'P2', 4, 4), creature('mine', 'P1', 2, 2)];
    const res = decide(request([counter]), view({ battlefield: board }), new Rng('a'));
    expect(res.targets).toEqual([{ slot: 0, choice: 'mine' }]);
  });

  it('does not put a +1/+1 counter on an opposing creature when it has none of its own', () => {
    const only = { ...counter, targets: [{ slot: 0, options: ['theirs'] }] };
    const board = [creature('theirs', 'P2', 4, 4)];
    expect(decide(request([PASS, only]), view({ battlefield: board }), new Rng('a')).actionId).toBe(
      0,
    );
  });

  function equip(options: string[]): LegalAction {
    return {
      id: 1,
      type: 'activateAbility',
      description: 'Sword: Equip {2}',
      targets: [{ slot: 0, options }],
      data: { sourceName: 'Sword', abilityDescription: 'Equip {2}', manaCost: '{2}' },
      interaction: { kind: 'source', sourceId: 'sword', sourceCardId: 'c-s', abilityIndex: 0 },
    };
  }
  const board = [creature('big', 'P1', 5, 5), creature('small', 'P1', 1, 1)];

  it('equips its best creature', () => {
    const res = decide(
      request([PASS, equip(['big', 'small'])]),
      view({ battlefield: board }),
      new Rng('a'),
    );
    expect(res.actionId).toBe(1);
    expect(res.targets).toEqual([{ slot: 0, choice: 'big' }]);
  });

  it('does not move equipment off its best creature, or equip twice in a turn', () => {
    // The menu leaves out the creature the equipment is already on.
    const moved = decide(
      request([PASS, equip(['small'])]),
      view({ battlefield: board }),
      new Rng('a'),
    );
    expect(moved.actionId).toBe(0);
    const again = decide(
      request([PASS, equip(['big', 'small'])]),
      view({ battlefield: board }),
      new Rng('a'),
      {
        repeatCount: () => 1,
      },
    );
    expect(again.actionId).toBe(0);
  });

  it('equips a restricted equip target even when a stronger creature is left out', () => {
    // "Equip commander" offers only the commander; the missing creature is not the host.
    const suit: LegalAction = {
      ...equip(['small']),
      description: 'Suit: Equip commander {3}',
      data: { sourceName: 'Suit', abilityDescription: 'Equip commander {3}', manaCost: '{3}' },
    };
    const res = decide(request([PASS, suit]), view({ battlefield: board }), new Rng('a'));
    expect(res.actionId).toBe(1);
  });

  it('crews only an uncrewed vehicle before its own combat', () => {
    const crew: LegalAction = {
      id: 1,
      type: 'activateAbility',
      description: 'Scythe: Crew 2',
      data: { sourceName: 'Scythe', abilityDescription: 'Crew 2' },
      interaction: { kind: 'source', sourceId: 'scythe', sourceCardId: 'c-v', abilityIndex: 0 },
    };
    const vehicle: PermanentView = {
      id: 'scythe',
      controller: 'P1',
      name: 'Scythe',
      typeLine: 'Artifact — Vehicle',
      tapped: false,
      status: [],
    };
    const crewed = { ...vehicle, power: 4, toughness: 4 };
    const go = (v: PermanentView, overrides: Partial<DecisionRequest> = {}): number =>
      decide(request([PASS, crew], overrides), view({ battlefield: [v, ...board] }), new Rng('a'))
        .actionId;
    expect(go(vehicle)).toBe(1);
    expect(go(crewed)).toBe(0);
    expect(go(vehicle, { activePlayer: 'P2' })).toBe(0);
    expect(go(vehicle, { phase: 'postcombatMain' })).toBe(0);
    // Crewing in response to an opponent's attack lets the Vehicle block.
    expect(go(vehicle, { activePlayer: 'P2', phase: 'combat', step: 'declareAttackers' })).toBe(1);
  });
});

describe('keywordStrip: an ability that only takes keywords away', () => {
  // Shadowspear as the server's classifier describes it: no role, ability 0 strips hexproof and
  // indestructible from opponents' permanents.
  const k = knowledge({
    Shadowspear: {
      manaValue: 1,
      types: ['Artifact'],
      abilityRoles: [[], []],
      abilityTargets: [[], ['friendly']],
      abilitySorcery: [false, true],
      abilityKeywordStrip: [
        {
          selector: { kind: 'controller', who: 'opponents' },
          keywords: ['hexproof', 'indestructible'],
        },
        null,
      ],
    },
  });
  const spear: LegalAction = {
    id: 1,
    type: 'activateAbility',
    description:
      'Shadowspear: {1}: Permanents your opponents control lose hexproof and indestructible until end of turn.',
    data: {
      sourceName: 'Shadowspear',
      abilityDescription:
        '{1}: Permanents your opponents control lose hexproof and indestructible until end of turn.',
      manaCost: '{1}',
    },
    interaction: { kind: 'source', sourceId: 'spear', sourceCardId: 'c-sp', abilityIndex: 0 },
  };
  const upkeep = { phase: 'beginning', step: 'upkeep' } as const;
  const pick = (
    battlefield: PermanentView[],
    opts: { repeats?: number; stack?: PlayerView['stack']; fixes?: PolicyFix[] } = {},
  ): number =>
    decide(
      request([PASS, spear], upkeep),
      view({ battlefield, stack: opts.stack ?? [] }),
      new Rng('a'),
      {
        knowledge: k,
        repeatCount: (a) => (a.id === spear.id ? (opts.repeats ?? 0) : 0),
        ...(opts.fixes === undefined ? {} : { fixes: opts.fixes }),
      },
    ).actionId;

  it('passes when no opposing permanent has hexproof or indestructible', () => {
    const board = [
      creature('bear', 'P2', 2, 2),
      creature('mine', 'P1', 3, 3, { keywords: ['hexproof'] }),
    ];
    expect(pick(board)).toBe(0);
  });

  it('activated three times per window without the fix: the bug this fix closes', () => {
    const board = [creature('bear', 'P2', 2, 2)];
    expect([0, 1, 2, 3].map((repeats) => pick(board, { repeats, fixes: [] }))).toEqual([
      1, 1, 1, 0,
    ]);
  });

  it('activates when an opposing permanent has hexproof, hexproof from a quality, or indestructible', () => {
    for (const keyword of ['hexproof', 'hexproof from black', 'indestructible'])
      expect({ keyword, pick: pick([creature('t', 'P2', 7, 6, { keywords: [keyword] })]) }).toEqual(
        {
          keyword,
          pick: 1,
        },
      );
  });

  it('reads absent keywords as none, unless the permanent is face down', () => {
    // The real view leaves `keywords` out of a permanent that has none.
    const { keywords: _none, ...vanilla } = creature('bear', 'P2', 2, 2);
    expect(pick([vanilla])).toBe(0);
    const { typeLine: _hidden, ...faceDown } = { ...vanilla, status: ['faceDown'] };
    expect(pick([faceDown])).toBe(1);
  });

  it('does not activate again while its own activation is still on the stack', () => {
    const board = [creature('t', 'P2', 7, 6, { keywords: ['hexproof'] })];
    const pending = [{ id: 's1', controller: 'P1', description: 'Shadowspear', targets: [] }];
    expect(pick(board, { repeats: 1, stack: pending })).toBe(0);
    // Resolved, then hexproof granted again: the view shows it, so a second activation is worth it.
    expect(pick(board, { repeats: 1 })).toBe(1);
  });

  it('respects the selector: a creatures-only strip ignores an opposing hexproof artifact', () => {
    const lighthouse = knowledge({
      'Arcane Lighthouse': {
        types: ['Land'],
        abilityRoles: [[]],
        abilityKeywordStrip: [
          {
            selector: {
              kind: 'allOf',
              of: [
                { kind: 'type', value: 'Creature' },
                { kind: 'controller', who: 'opponents' },
              ],
            },
            keywords: ['hexproof', 'shroud'],
          },
        ],
      },
    });
    const ability: LegalAction = {
      ...spear,
      description: 'Arcane Lighthouse: strip',
      data: { sourceName: 'Arcane Lighthouse', abilityDescription: 'strip' },
      interaction: { kind: 'source', sourceId: 'lh', sourceCardId: 'c-lh', abilityIndex: 0 },
    };
    const artifact: PermanentView = {
      id: 'relic',
      controller: 'P2',
      name: 'Relic',
      typeLine: 'Artifact',
      tapped: false,
      status: [],
      keywords: ['hexproof'],
    };
    const go = (battlefield: PermanentView[]): number =>
      decide(request([PASS, ability], upkeep), view({ battlefield }), new Rng('a'), {
        knowledge: lighthouse,
      }).actionId;
    expect(go([artifact])).toBe(0);
    expect(go([creature('c', 'P2', 1, 1, { keywords: ['shroud'] })])).toBe(1);
  });
});

describe('resolution-time card choices', () => {
  // The engine's `chooseCard` menus carry no payload, so `interactionFor` yields a bare
  // `{ kind: 'choice' }`; the card is named only in the decision's presentation.
  function presentedChoice(
    type: string,
    cards: Array<{ id: string; name: string; typeLine: string; zone: string }>,
  ): DecisionRequest {
    const legalActions: LegalAction[] = cards.map((c, i) => ({
      id: i,
      type,
      description: `Discard ${c.name}`,
      interaction: { kind: 'choice' },
    }));
    const actions = Object.fromEntries(
      cards.map((c, i) => [
        i,
        {
          verb: 'Discard',
          role: 'select' as const,
          subjects: [
            {
              kind: 'card' as const,
              card: {
                objectId: c.id,
                name: c.name,
                scryfallId: null,
                typeLine: c.typeLine,
                zone: c.zone as 'hand',
              },
            },
          ],
        },
      ]),
    );
    return request(legalActions, {
      decisionType: 'general',
      presentation: { layout: 'cards', actions },
    });
  }

  it('discards the cheap card and keeps the bomb when the menu has no subject ids', () => {
    const hand = [
      card('bomb', 'Expensive Bomb', 'Sorcery', '{6}{B}{B}'),
      card('cheap', 'Cheap Trick', 'Instant', '{U}'),
    ];
    const req = presentedChoice('discard', [
      { id: 'bomb', name: 'Expensive Bomb', typeLine: 'Sorcery', zone: 'hand' },
      { id: 'cheap', name: 'Cheap Trick', typeLine: 'Instant', zone: 'hand' },
    ]);
    const k = knowledge({ 'Expensive Bomb': { manaValue: 8 }, 'Cheap Trick': { manaValue: 1 } });
    const ranked = evaluate(req, view({ hand }), { knowledge: k });
    expect(ranked[0]!.action.id).toBe(1);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it('values a card from a hidden zone by its presented name', () => {
    // A library search: neither card is in the view, only in the presentation.
    const req = presentedChoice('search', [
      { id: 'l1', name: 'Cheap Trick', typeLine: 'Instant', zone: 'library' },
      { id: 'l2', name: 'Expensive Bomb', typeLine: 'Sorcery', zone: 'library' },
    ]);
    const k = knowledge({ 'Expensive Bomb': { manaValue: 8 }, 'Cheap Trick': { manaValue: 1 } });
    const ranked = evaluate(req, view(), { knowledge: k });
    expect(ranked[0]!.action.id).toBe(1);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });
});

describe('review fixes', () => {
  it('counters a counterspell aimed at its own spell (the top of the stack is the last entry)', () => {
    const counter: LegalAction = {
      id: 1,
      type: 'castSpell',
      description: 'Cast Negate',
      targets: [{ slot: 0, options: ['s1', 's2'] }],
      data: { sourceName: 'Negate', manaCost: '{1}{U}', instantSpeed: true },
    };
    const k = knowledge({
      Negate: { manaValue: 2, roles: ['counter'], spellTargets: ['hostile'] },
    });
    const stack = [
      { id: 's1', controller: 'P1', description: 'Cast My Bomb', targets: [] },
      { id: 's2', controller: 'P2', description: 'Cast Counterspell', targets: ['s1'] },
    ];
    const res = decide(
      request([PASS, counter], { activePlayer: 'P1' }),
      view({ stack } as Partial<PlayerView>),
      new Rng('a'),
      { knowledge: k },
    );
    expect(res.actionId).toBe(1);
    expect(res.targets).toEqual([{ slot: 0, choice: 's2' }]);
  });

  it('sees a crewed Vehicle as a blocker', () => {
    const attack: LegalAction = {
      id: 1,
      type: 'attackDeclaration',
      description: 'Declare attackers',
      targets: [{ slot: 0, options: ['P2', NO_ATTACK_TARGET] }],
      data: {
        subjects: [
          { subjectId: 'a1', power: 3, toughness: 1, mustAttack: false, hasTriggers: false },
        ],
      },
    };
    const vehicle: PermanentView = {
      id: 'v1',
      controller: 'P2',
      name: 'Night Scythe',
      typeLine: 'Artifact — Vehicle',
      power: 4,
      toughness: 4,
      tapped: false,
      status: [],
    };
    const res = decide(
      request([attack], {
        decisionType: 'declareAttackers',
        phase: 'combat',
        step: 'declareAttackers',
      }),
      view({ battlefield: [creature('a1', 'P1', 3, 1), vehicle] }),
      new Rng('a'),
    );
    expect(res.targets).toEqual([{ slot: 0, choice: NO_ATTACK_TARGET }]);
  });
});
