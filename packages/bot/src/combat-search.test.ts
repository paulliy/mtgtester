import { describe, expect, it } from 'vitest';
import type { LegalAction, PermanentView, PlayerView } from '@mtg/shared';
import { NO_BLOCK_TARGET } from '@mtg/shared';
import {
  searchBlockAssignment,
  searchDamageSplit,
  staticBlockChoices,
  staticDamageSplit,
} from './combat-search';
import { WEIGHTS } from './weights';

/**
 * These fixtures put the deciding seat's OWN blockers on the battlefield, which the ADR 0023
 * Phase 4 fixtures in `evaluate.test.ts` do not. That matters: the search reads its bodies (and
 * their keywords) from the view and declines outright when it can't find one, so a fixture that
 * omits them exercises only the static fallback. Defending seat is `P2` throughout; attackers are
 * controlled by `P1`.
 */
function view(overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    seat: 'P2',
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
        seat: 'P1',
        life: 40,
        handSize: 0,
        librarySize: 60,
        graveyard: [],
        commanders: [],
        poisonCounters: 0,
        commanderDamageDealtToYou: 0,
      },
    ],
    ...overrides,
  };
}

function creature(
  id: string,
  controller: string,
  power: number,
  toughness: number,
  keywords: string[] = [],
): PermanentView {
  const perm: PermanentView = {
    id,
    controller,
    name: id,
    power,
    toughness,
    tapped: false,
    status: [],
  };
  if (keywords.length > 0) perm.keywords = keywords;
  return perm;
}

function blockAction(
  subjects: { subjectId: string; power: number; toughness: number; mustBlock: boolean }[],
  options: string[][],
): LegalAction {
  return {
    id: 0,
    type: 'blockDeclaration',
    description: 'Declare blockers',
    data: { subjects },
    targets: options.map((opts, i) => ({ slot: i, options: opts })),
  };
}

const two = (id: string, power: number, toughness: number) => ({
  subjectId: id,
  power,
  toughness,
  mustBlock: false,
});

describe('searchBlockAssignment — what the beam finds that a per-blocker rule cannot', () => {
  it('gang-blocks a threat neither blocker could answer alone', () => {
    // Two 3/3s against a 5/5. Individually neither survives it (3 < 5) nor trades with it
    // (3 < 5 toughness), so Phase 4's per-blocker rule declines with both and eats 5 damage.
    // Together they kill it for the price of one body — the whole reason ADR 0024 wanted the
    // search to consider assignments rather than blockers.
    const action = blockAction(
      [two('X', 3, 3), two('Y', 3, 3)],
      [
        ['A', NO_BLOCK_TARGET],
        ['A', NO_BLOCK_TARGET],
      ],
    );
    const v = view({
      battlefield: [
        creature('A', 'P1', 5, 5),
        creature('X', 'P2', 3, 3),
        creature('Y', 'P2', 3, 3),
      ],
    });

    expect(staticBlockChoices(action, v)).toEqual([null, null]);
    expect(searchBlockAssignment(action, v)).toEqual(['A', 'A']);
  });

  it('never proposes a single blocker on a menace attacker — it gang-blocks or declines', () => {
    const action = blockAction(
      [two('X', 2, 2), two('Y', 2, 2)],
      [
        ['M', NO_BLOCK_TARGET],
        ['M', NO_BLOCK_TARGET],
      ],
    );
    const v = view({
      battlefield: [
        creature('M', 'P1', 3, 3, ['menace']),
        creature('X', 'P2', 2, 2),
        creature('Y', 'P2', 2, 2),
      ],
    });

    const chosen = searchBlockAssignment(action, v);
    expect(chosen).not.toBeNull();
    const onMenace = (chosen as (string | null)[]).filter((c) => c === 'M').length;
    expect(onMenace).not.toBe(1);
  });
});

describe('searchBlockAssignment — the 1-ply lethal horizon', () => {
  const chumpAction = blockAction([two('X', 1, 1)], [['A', NO_BLOCK_TARGET]]);
  const chumpBoard = [creature('A', 'P1', 5, 5), creature('X', 'P2', 1, 1)];

  it('keeps the body at a healthy life total rather than chumping for 5', () => {
    expect(searchBlockAssignment(chumpAction, view({ life: 40, battlefield: chumpBoard }))).toEqual(
      [null],
    );
  });

  it('chumps once declining would actually be fatal', () => {
    // At 5 life the 5/5 is lethal on the spot, so the body is spent without hesitation. Note this
    // is NOT the flat `dangerousLifeThreshold` Phase 4 uses — the search declines at 10, one point
    // *below* which Phase 4 starts chumping, because at 10 taking 5 and chumping next turn reaches
    // the same place a turn later with the body still on the board.
    expect(searchBlockAssignment(chumpAction, view({ life: 5, battlefield: chumpBoard }))).toEqual([
      'A',
    ]);
    expect(staticBlockChoices(chumpAction, view({ life: 10, battlefield: chumpBoard }))).toEqual([
      'A',
    ]);
    expect(searchBlockAssignment(chumpAction, view({ life: 10, battlefield: chumpBoard }))).toEqual(
      [null],
    );
  });
});

describe('searchBlockAssignment — when it declines (ADR 0024 Decision item 5)', () => {
  it('declines above the width cutoff instead of paying for a wide board', () => {
    const count = WEIGHTS.combat.maxAttackers + 1;
    const attackerIds = Array.from({ length: count }, (_, i) => `A${i}`);
    const action = blockAction([two('X', 2, 2)], [[...attackerIds, NO_BLOCK_TARGET]]);
    const v = view({
      battlefield: [
        ...attackerIds.map((id) => creature(id, 'P1', 2, 2)),
        creature('X', 'P2', 2, 2),
      ],
    });
    expect(searchBlockAssignment(action, v)).toBeNull();
  });

  it('declines rather than inventing a body the view does not show', () => {
    // The search never fills a gap in the view with a guess (brief §7.1 cuts both ways: it does
    // not see hidden state, and it does not pretend to). An attacker it cannot find is a fallback,
    // not an assumed vanilla creature.
    const action = blockAction([two('X', 2, 2)], [['ghost', NO_BLOCK_TARGET]]);
    const v = view({ battlefield: [creature('X', 'P2', 2, 2)] });
    expect(searchBlockAssignment(action, v)).toBeNull();
  });

  it('is deterministic — no RNG, and no dependence on call order', () => {
    const action = blockAction(
      [two('X', 3, 3), two('Y', 3, 3)],
      [
        ['A', 'B', NO_BLOCK_TARGET],
        ['A', 'B', NO_BLOCK_TARGET],
      ],
    );
    const v = view({
      battlefield: [
        creature('A', 'P1', 4, 4),
        creature('B', 'P1', 2, 2),
        creature('X', 'P2', 3, 3),
        creature('Y', 'P2', 3, 3),
      ],
    });
    const first = searchBlockAssignment(action, v);
    expect(searchBlockAssignment(action, v)).toEqual(first);
    expect(searchBlockAssignment(action, structuredClone(v))).toEqual(first);
  });
});

describe('CombatSearchOptions — the switch the 7c sweep runs both arms with', () => {
  const action = blockAction(
    [two('X', 3, 3), two('Y', 3, 3)],
    [
      ['A', NO_BLOCK_TARGET],
      ['A', NO_BLOCK_TARGET],
    ],
  );
  const v = view({
    battlefield: [creature('A', 'P1', 5, 5), creature('X', 'P2', 3, 3), creature('Y', 'P2', 3, 3)],
  });

  it('disabled reproduces the Phase 4 heuristic exactly — that is what makes it a control arm', () => {
    expect(searchBlockAssignment(action, v, { enabled: false })).toBeNull();
    // Null is the caller's signal to use `staticBlockChoices`, so the control arm is the Phase 4
    // answer and nothing else. If this ever stopped being true the sweep would be measuring the
    // search against a second, subtly different heuristic rather than against the one it replaces.
    expect(staticBlockChoices(action, v)).toEqual([null, null]);
  });

  it('honours an overridden bound rather than the shipped one', () => {
    expect(searchBlockAssignment(action, v, { maxCombatPermanents: 2 })).toBeNull();
    expect(searchBlockAssignment(action, v, { maxAttackers: 0 })).toBeNull();
    expect(searchBlockAssignment(action, v, { maxCombatPermanents: 99 })).toEqual(['A', 'A']);
  });

  it('reports engagement through onSearch, for both outcomes', () => {
    const seen: [string, boolean][] = [];
    const onSearch = (kind: 'block' | 'split', searched: boolean): void => {
      seen.push([kind, searched]);
    };
    searchBlockAssignment(action, v, { onSearch });
    searchBlockAssignment(action, v, { enabled: false, onSearch });
    expect(seen).toEqual([
      ['block', true],
      ['block', false],
    ]);
  });

  it('a narrower beam is still a legal answer, never a broken one', () => {
    // topK 1 is pure greedy — the sweep's floor case. It must still return a complete, per-slot
    // assignment; only its quality is allowed to vary.
    const chosen = searchBlockAssignment(action, v, { topK: 1 });
    expect(chosen).not.toBeNull();
    expect((chosen as (string | null)[]).length).toBe(2);
  });
});

describe('searchDamageSplit — deathtouch is what Phase 4 could not see', () => {
  it('spends 1 per blocker with deathtouch and tramples the rest over', () => {
    // A 4/4 deathtouch trampler against two 3/3s. Phase 4 reads lethal as plain toughness, covers
    // one blocker for 3 and has 1 left that legally cannot reach the player (CR 702.19b) — the
    // engine would reject that and dump all 4 on the first blocker. Deathtouch makes 1 lethal
    // (CR 702.2c), so both blockers die and 2 gets through.
    const v = view({
      seat: 'P1',
      life: 40,
      opponents: [
        {
          seat: 'P2',
          life: 40,
          handSize: 0,
          librarySize: 60,
          graveyard: [],
          commanders: [],
          poisonCounters: 0,
          commanderDamageDealtToYou: 0,
        },
      ],
      battlefield: [
        {
          ...creature('T', 'P1', 4, 4, ['deathtouch', 'trample']),
          blockedBy: ['bA', 'bB'],
        },
        creature('bA', 'P2', 3, 3),
        creature('bB', 'P2', 3, 3),
      ],
    });
    const split = searchDamageSplit({ amount: 4, targets: ['bA', 'bB', 'P2'] }, v);
    expect(split).toEqual({ bA: 1, bB: 1, P2: 2 });
  });

  it('declines when it cannot tell which attacker is dividing', () => {
    const v = view({
      seat: 'P1',
      battlefield: [creature('bA', 'P2', 3, 3), creature('bB', 'P2', 3, 3)],
    });
    expect(searchDamageSplit({ amount: 4, targets: ['bA', 'bB'] }, v)).toBeNull();
  });
});

describe('staticDamageSplit with a planeswalker as the trample recipient', () => {
  it('sends the excess to the planeswalker and never treats it as a blocker', () => {
    const walker: PermanentView = {
      id: 'pw1',
      controller: 'P2',
      name: 'Walker',
      power: null,
      toughness: null,
      tapped: false,
      status: [],
    };
    const v = view({ battlefield: [creature('b1', 'P2', 1, 2), walker] });
    expect(staticDamageSplit({ amount: 5, targets: ['b1', 'pw1'] }, v)).toEqual({
      b1: 2,
      pw1: 3,
    });
  });
});
