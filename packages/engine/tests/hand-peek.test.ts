/**
 * "Look at target player's hand" (Gitaxian Probe, Peek): a private look (CR 402.3). Only the
 * player who looked learns the cards, as they were at the look: a card that leaves the hand is a
 * new object (CR 400.7) and is forgotten, and later draws were never seen. Looking is not
 * revealing (CR 701.20a), so no other seat, log line, event or AI context learns any name.
 */

import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { resolveTopOfStack } from '../src/stack/stack';
import { moveObject } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { checkStateInvariants } from '../src/testing/invariants';
import { buildPlayerBoardState, formatPlayerLog } from '../src/view/spectator';
import { buildPlayerView } from '../src/view/view';
import { conjure, oracle, pump } from './fixtures';
import { castFromHand, p, pod } from './pr10-helpers';

const peek = (): OracleCard =>
  oracle({
    name: 'Peek',
    typeLine: 'Instant',
    manaCost: '{U}',
    cmc: 1,
    colors: ['U'],
    colorIdentity: ['U'],
    power: null,
    toughness: null,
    oracleText: "Look at target player's hand.\nDraw a card.",
  });

const probe = (): OracleCard =>
  oracle({
    name: 'Gitaxian Probe',
    typeLine: 'Sorcery',
    manaCost: '{U/P}',
    cmc: 1,
    colors: ['U'],
    colorIdentity: ['U'],
    power: null,
    toughness: null,
    oracleText:
      "({U/P} can be paid with either {U} or 2 life.)\nLook at target player's hand.\nDraw a card.",
  });

const secret = (name: string): OracleCard =>
  oracle({ name, typeLine: 'Sorcery', manaCost: '{1}', cmc: 1, oracleText: 'Draw a card.' });

const SECRETS = ['Secret Alpha', 'Secret Bravo', 'Secret Charlie'];

function peekAt(seed: string, target = 'P2'): GameContext {
  const ctx = pod(seed);
  for (const name of SECRETS) conjure(ctx, 'P2', secret(name), 'hand');
  castFromHand(ctx, 'P1', peek(), new Map([[0, target]]));
  pump(resolveTopOfStack(ctx));
  return ctx;
}

const knownNames = (ctx: GameContext, viewer: string, owner: string): string[] =>
  (buildPlayerView(ctx, viewer).opponents.find((o) => o.seat === owner)?.knownHand ?? []).map(
    (card) => card.name,
  );

describe('look at target player hand: parsing', () => {
  it.each([peek(), probe()])('$name is modeled as a look, then a draw', (card) => {
    const def = interpretCard(card);
    expect(def.unmodeledReasons).toEqual([]);
    expect(def.spellAbility?.targets).toEqual([{ kind: 'player' }]);
    expect(def.spellAbility?.effects.map((effect) => effect.op)).toEqual(['lookAtHand', 'draw']);
  });
});

describe('look at target player hand: what the looker knows', () => {
  it('shows the looker the exact hand and draws a card', () => {
    const ctx = peekAt('peek-basic');
    expect(knownNames(ctx, 'P1', 'P2')).toEqual(SECRETS);
    expect(p(ctx, 'P1').hand).toHaveLength(1);
    const board = buildPlayerBoardState(ctx, 'P1');
    expect(board.knownHands?.map((entry) => entry.player)).toEqual(['P2']);
    expect(board.knownHands?.[0]?.cards.map((card) => card.name)).toEqual(SECRETS);
  });

  it('does not learn a card the target draws afterwards', () => {
    const ctx = peekAt('peek-later-draw');
    conjure(ctx, 'P2', secret('Secret Delta'), 'hand');
    expect(knownNames(ctx, 'P1', 'P2')).toEqual(SECRETS);
  });

  it('forgets a card that leaves the hand, even when it comes back (CR 400.7)', () => {
    const ctx = peekAt('peek-leaves');
    const [alpha, bravo] = p(ctx, 'P2').hand;
    pump(moveObject(ctx, alpha!, { zone: 'graveyard' }));
    expect(knownNames(ctx, 'P1', 'P2')).toEqual(['Secret Bravo', 'Secret Charlie']);
    pump(moveObject(ctx, bravo!, { zone: 'exile' }));
    const exiled = ctx.state.exile.find((card) => card.name === 'Secret Bravo')!;
    pump(moveObject(ctx, exiled, { zone: 'hand' }));
    expect(p(ctx, 'P2').hand.map((card) => card.name)).toContain('Secret Bravo');
    expect(knownNames(ctx, 'P1', 'P2')).toEqual(['Secret Charlie']);
  });

  it('refreshes on a second look', () => {
    const ctx = peekAt('peek-refresh');
    conjure(ctx, 'P2', secret('Secret Delta'), 'hand');
    castFromHand(ctx, 'P1', peek(), new Map([[0, 'P2']]));
    pump(resolveTopOfStack(ctx));
    expect(knownNames(ctx, 'P1', 'P2')).toEqual([...SECRETS, 'Secret Delta']);
    expect(p(ctx, 'P1').knownHandCards).toHaveLength(4);
  });

  it('learns nothing and draws nothing when the target is gone (CR 608.2b)', () => {
    const ctx = pod('peek-fizzle');
    for (const name of SECRETS) conjure(ctx, 'P2', secret(name), 'hand');
    castFromHand(ctx, 'P1', peek(), new Map([[0, 'P2']]));
    p(ctx, 'P2').hasLost = true;
    pump(resolveTopOfStack(ctx));
    expect(p(ctx, 'P1').knownHandCards).toBeUndefined();
    expect(p(ctx, 'P1').hand).toHaveLength(0);
  });

  it('keeps the state free of the field in a game where nobody looked', () => {
    const ctx = pod('peek-none');
    expect(ctx.state.players.every((player) => player.knownHandCards === undefined)).toBe(true);
    expect(buildPlayerView(ctx, 'P1').opponents.every((o) => !('knownHand' in o))).toBe(true);
    expect('knownHands' in buildPlayerBoardState(ctx, 'P1')).toBe(false);
  });
});

describe('look at target player hand: nothing leaks', () => {
  it('shows no hand card to any other seat, its board, its log or the raw events', () => {
    const ctx = peekAt('peek-leak');
    const handIds = p(ctx, 'P2').hand.map((card) => card.id);
    for (const seat of ['P3', 'P4']) {
      const view = JSON.stringify(buildPlayerView(ctx, seat));
      const board = JSON.stringify(buildPlayerBoardState(ctx, seat));
      for (const secretText of [...SECRETS, ...handIds]) {
        expect(view).not.toContain(secretText);
        expect(board).not.toContain(secretText);
      }
    }
    const events = JSON.stringify(ctx.state.eventLog);
    for (const name of SECRETS) expect(events).not.toContain(name);
    for (const seat of ['P1', 'P2', 'P3', 'P4']) {
      const log = JSON.stringify(formatPlayerLog(ctx.state.eventLog, seat));
      for (const name of SECRETS) expect(log).not.toContain(name);
    }
    expect(
      formatPlayerLog(ctx.state.eventLog, 'P3').some((line) =>
        line.text.includes("looks at P2's hand (3 cards)"),
      ),
    ).toBe(true);
  });

  it('passes the privacy invariant and ignores knowledge of a card no longer in the hand', () => {
    const ctx = peekAt('peek-invariant');
    expect(checkStateInvariants(ctx, { privacy: true })).toEqual([]);
    p(ctx, 'P3').knownHandCards = [{ owner: 'P2', objectId: 'not-in-hand' }];
    expect(checkStateInvariants(ctx, { privacy: true })).toEqual([]);
  });

  it('does not let the target see anything new in its own view', () => {
    const ctx = peekAt('peek-target-view');
    const own = buildPlayerView(ctx, 'P2');
    expect(own.hand.map((card) => card.name)).toEqual(SECRETS);
    expect(own.opponents.some((o) => o.knownHand !== undefined)).toBe(false);
  });
});
