/**
 * Two-commander decks (CR 702.124, 903.3c): the pairing keywords are deck construction only, so
 * they parse to nothing in a game; "Partner with <name>" also carries its enters tutor trigger
 * (CR 702.124j). Each commander pays its own tax (CR 903.8, 702.124d) and commander damage is
 * counted per commander (CR 903.10a).
 */

import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { computePriorityOptions } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { priorityCheckpoint } from '../src/sba/sba';
import { resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import {
  commanderFor,
  conjure,
  copies,
  forest,
  gameConfig,
  oracle,
  pumpStrict,
  spawn,
} from './fixtures';
import { castFromHand, choose, p, pod, putPendingTriggersOnStack, settle } from './pr10-helpers';
import { script } from './script';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';

/** Answers a trigger's target decision by naming its "Targets for" option and the player. */
const targetsPlayer =
  (player: string) =>
  (decision: PendingDecision): DecisionOutcome => {
    const index = decision.options.findIndex((option) =>
      option.description.startsWith('Targets for'),
    );
    if (index < 0) throw new Error(`no target option in "${decision.prompt}"`);
    return { index, targets: new Map([[0, player]]) };
  };

const legend = (name: string, oracleText: string, manaCost = '{1}{G}'): OracleCard =>
  oracle({
    name,
    typeLine: 'Legendary Creature — Hobbit',
    manaCost,
    colors: ['G'],
    colorIdentity: ['G'],
    power: '2',
    toughness: '2',
    oracleText,
  });

describe('pairing keywords parse as deck construction only', () => {
  it.each([
    ['Partner', 'Partner (You can have two commanders if both have partner.)'],
    [
      'Choose a Background',
      'Choose a Background (You can have a Background as a second commander.)',
    ],
    [
      'Friends forever',
      'Friends forever (You can have two commanders if both have friends forever.)',
    ],
    [
      'Partner variant',
      'Partner—Character select (You can have two commanders if both have this ability.)',
    ],
    [
      "Doctor's companion",
      "Doctor's companion (You can have two commanders if the other is the Doctor.)",
    ],
  ])('%s is modeled with no abilities', (_label, line) => {
    const def = interpretCard(legend('Pair Test', `${line}\nTrample`));
    expect(def.unmodeledReasons).toEqual([]);
    expect(def.triggers ?? []).toEqual([]);
    expect(def.keywords).toContain('trample');
  });

  it('still rejects an unrelated "partner" sentence', () => {
    const def = interpretCard(legend('Pair Test', 'Partner creatures you control get +1/+1.'));
    expect(def.unmodeledReasons.length).toBeGreaterThan(0);
  });
});

describe('Partner with (CR 702.124j)', () => {
  const merry = legend(
    'Merry, Esquire of Rohan',
    'Partner with Pippin, Guard of the Citadel (When this creature enters, target player may put Pippin into their hand from their library, then shuffle.)',
  );
  const pippin = (): OracleCard => legend('Pippin, Guard of the Citadel', 'Vigilance');

  it('parses to one targeted enters trigger naming the full partner name', () => {
    const def = interpretCard(merry);
    expect(def.unmodeledReasons).toEqual([]);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers?.[0]?.targets).toEqual([{ kind: 'player' }]);
    expect(def.triggers?.[0]?.effects).toEqual([
      { op: 'targetPlayerMaySearchNamed', target: 0, name: 'Pippin, Guard of the Citadel' },
    ]);
  });

  it('lets an opponent targeted by the trigger search their own library', () => {
    const ctx = pod('pairs-partner-with-opponent');
    const card = conjure(ctx, 'P2', pippin(), 'library');
    castFromHand(ctx, 'P1', merry);
    pumpStrict(resolveTopOfStack(ctx));
    putPendingTriggersOnStack(
      ctx,
      script([
        {
          prompt: 'Choose targets for Merry',
          answer: targetsPlayer('P2'),
        },
      ]),
    );
    settle(ctx, (decision) =>
      decision.options.some((option) => option.description === 'Search')
        ? choose('Search')(decision)
        : choose('Pippin')(decision),
    );
    expect(p(ctx, 'P2').hand.some((c) => c.cardId === card.cardId)).toBe(true);
    expect(p(ctx, 'P1').hand).toHaveLength(0);
  });

  it('can be declined, leaving the library as it was', () => {
    const ctx = pod('pairs-partner-with-decline');
    conjure(ctx, 'P1', pippin(), 'library');
    const order = p(ctx, 'P1').library.map((card) => card.id);
    castFromHand(ctx, 'P1', merry);
    pumpStrict(resolveTopOfStack(ctx));
    putPendingTriggersOnStack(
      ctx,
      script([
        {
          prompt: 'Choose targets for Merry',
          answer: targetsPlayer('P1'),
        },
      ]),
    );
    settle(ctx, choose("Don't search"));
    expect(p(ctx, 'P1').library.map((card) => card.id)).toEqual(order);
  });
});

function pairGame(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [
        {
          commanders: [commanderFor('G', 'Partner One'), commanderFor('W', 'Partner Two')],
          cards: copies(10, forest),
        },
        { cards: copies(10, forest) },
        { cards: copies(10, forest) },
        { cards: copies(10, forest) },
      ],
      { seed },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  return ctx;
}

describe('two commanders in a game', () => {
  it('starts both commanders in the command zone', () => {
    const ctx = pairGame('pairs-setup');
    expect(p(ctx, 'P1').commandZone.map((card) => card.name)).toEqual([
      'Partner One',
      'Partner Two',
    ]);
    expect(p(ctx, 'P1').commanderCardIds).toHaveLength(2);
    expect([...p(ctx, 'P1').commanderColorIdentity].sort()).toEqual(['G', 'W']);
  });

  it('taxes each commander by its own cast count (CR 702.124d)', () => {
    const ctx = pairGame('pairs-tax');
    const [one, two] = p(ctx, 'P1').commandZone;
    p(ctx, 'P1').commanderCastCount[one!.cardId] = 1;
    for (let i = 0; i < 6; i++) spawn(ctx, 'P1', forest());
    const offered = computePriorityOptions(ctx, p(ctx, 'P1')).map((option) => option.description);
    expect(offered.some((d) => d.includes('Partner One') && d.includes('commander tax {2}'))).toBe(
      true,
    );
    expect(offered.some((d) => d.includes('Partner Two') && d.includes('commander tax'))).toBe(
      false,
    );
    expect(two).toBeDefined();
  });

  it('counts commander damage per commander (CR 903.10a)', () => {
    const ctx = pairGame('pairs-damage');
    const [one, two] = p(ctx, 'P1').commandZone;
    const victim = p(ctx, 'P2');
    victim.commanderDamageTaken[one!.cardId] = 20;
    victim.commanderDamageTaken[two!.cardId] = 20;
    pumpStrict(priorityCheckpoint(ctx));
    expect(victim.hasLost).toBe(false);
    victim.commanderDamageTaken[one!.cardId] = 21;
    pumpStrict(priorityCheckpoint(ctx));
    expect(victim.hasLost).toBe(true);
  });
});
