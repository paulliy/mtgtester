/**
 * The real Oracle text of the cards commander pairs and the private hand look unblock, pinned in
 * `fixtures/pairs-and-hand-look-oracle.json` (from the EDHREC pin file, with a SHA-256 per card).
 * Every card models from its printed text, and the hand-look cards work through the normal cast
 * and activation paths: only the player who looked sees the hand (CR 402.3, 701.20a).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId, getOverride } from '../src/cards/overrides';
import { resolveTopOfStack } from '../src/stack/stack';
import type { GameContext } from '../src/state/types';
import { buildPlayerView } from '../src/view/view';
import { conjure, oracle, pump, spawn } from './fixtures';
import {
  activate,
  castFromHand,
  choose,
  p,
  pod,
  putPendingTriggersOnStack,
  settle,
} from './pr10-helpers';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}

const pinnedCards = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/pairs-and-hand-look-oracle.json'), 'utf8'),
  ) as PinnedFixture
).cards;

function pinned(name: string): OracleCard {
  const entry = pinnedCards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`missing pinned Oracle fixture for ${name}`);
  return entry.card;
}

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

/** Cards whose other lines an older override authors; their pairing line still parses. */
const AUTHORED_ELSEWHERE = new Set(['Gut, True Soul Zealot']);

const SECRETS = ['Secret Alpha', 'Secret Bravo'];
const secret = (name: string): OracleCard =>
  oracle({ name, typeLine: 'Sorcery', manaCost: '{1}', cmc: 1, oracleText: 'Draw a card.' });

function withSecrets(seed: string): GameContext {
  const ctx = pod(seed);
  for (const name of SECRETS) conjure(ctx, 'P2', secret(name), 'hand');
  return ctx;
}

const knownNames = (ctx: GameContext, viewer: string): string[] =>
  (buildPlayerView(ctx, viewer).opponents.find((o) => o.seat === 'P2')?.knownHand ?? []).map(
    (card) => card.name,
  );

describe('pinned pair and hand-look cards', () => {
  it('pairs-hand-look-pinned — the fixture matches its pins and every card models', () => {
    expect(pinnedCards).toHaveLength(16);
    for (const { sha256, card } of pinnedCards) {
      expect(createHash('sha256').update(canonical(card)).digest('hex'), card.name).toBe(sha256);
      for (const candidate of [card, { ...card, oracleId: fixtureOracleId(card.name) }]) {
        expect(interpretCard(candidate).unmodeledReasons, card.name).toEqual([]);
      }
      if (!AUTHORED_ELSEWHERE.has(card.name))
        expect(getOverride(card.oracleId), card.name).toBeUndefined();
    }
  });

  it.each([
    ['Merry, Warden of Isengard', 'Pippin, Warden of Isengard'],
    ['Alphinaud Leveilleur', 'Alisaie Leveilleur'],
    ['Rocksteady, Mutant Marauder', 'Bebop, Skull & Crossbones'],
  ])('pairs-partner-with-ir — %s searches for %s by full name', (name, partner) => {
    const triggers = interpretCard(pinned(name)).triggers ?? [];
    const search = triggers.filter((trigger) =>
      trigger.effects.some((effect) => effect.op === 'targetPlayerMaySearchNamed'),
    );
    expect(search).toHaveLength(1);
    expect(search[0]?.trigger).toMatchObject({ when: 'enters' });
    expect(search[0]?.targets).toEqual([{ kind: 'player' }]);
    expect(search[0]?.effects).toEqual([
      { op: 'targetPlayerMaySearchNamed', target: 0, name: partner },
    ]);
  });

  it('pairs-merry-tutor — the real Merry finds Pippin for its controller when cast', () => {
    const ctx = pod('pinned-merry');
    const pippin = conjure(
      ctx,
      'P1',
      oracle({ name: 'Pippin, Warden of Isengard', typeLine: 'Legendary Creature — Halfling' }),
      'library',
    );
    castFromHand(ctx, 'P1', pinned('Merry, Warden of Isengard'));
    pump(resolveTopOfStack(ctx));
    putPendingTriggersOnStack(ctx, () => ({ index: 0, targets: new Map([[0, 'P1']]) }));
    settle(ctx, (decision) =>
      decision.options.some((option) => option.description === 'Search')
        ? choose('Search')(decision)
        : choose('Pippin')(decision),
    );
    expect(p(ctx, 'P1').hand.some((card) => card.cardId === pippin.cardId)).toBe(true);
  });

  it.each(['Peek', 'Gitaxian Probe'])(
    'hand-look-cast — the real %s shows P1 the hand, draws, and shows P3 nothing',
    (name) => {
      const ctx = withSecrets(`pinned-${name}`);
      castFromHand(ctx, 'P1', pinned(name), new Map([[0, 'P2']]));
      pump(resolveTopOfStack(ctx));
      expect(knownNames(ctx, 'P1')).toEqual(SECRETS);
      expect(p(ctx, 'P1').hand).toHaveLength(1);
      expect(knownNames(ctx, 'P3')).toEqual([]);
      const third = JSON.stringify(buildPlayerView(ctx, 'P3'));
      for (const hidden of SECRETS) expect(third).not.toContain(hidden);
    },
  );

  it('hand-look-glasses — the real Glasses of Urza looks through its tap activation', () => {
    const ctx = withSecrets('pinned-glasses');
    const glasses = spawn(ctx, 'P1', pinned('Glasses of Urza'));
    activate(ctx, 'P1', glasses, new Map([[0, 'P2']]));
    expect(glasses.tapped).toBe(true);
    pump(resolveTopOfStack(ctx));
    expect(knownNames(ctx, 'P1')).toEqual(SECRETS);
    expect(p(ctx, 'P1').hand).toHaveLength(0);
  });
});
