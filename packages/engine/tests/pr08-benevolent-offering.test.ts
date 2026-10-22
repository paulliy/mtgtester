import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { computeCharacteristics } from '../src/effects/continuous';
import { computePriorityOptions } from '../src/actions/legal';
import { addMana } from '../src/mana/pool';
import { changeController, playerById } from '../src/state/objects';
import { SPIRIT_1_1_FLYING } from '../src/cards/tokens';
import { conjure, oracle, registerCustomDef, spawn } from './fixtures';
import {
  sharedOpponentPod,
  castSharedOpponentSpell,
  settleSharedOpponentSpell,
} from './shared-opponent-fixtures';
const pin = (
  JSON.parse(readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8')) as {
    cards: { sha256: string; card: OracleCard }[];
  }
).cards.find((entry) => entry.card.name === 'Benevolent Offering')!;
const card = pin.card;
describe('PR08.22 Benevolent Offering', () => {
  it('offering-pinned-oracle-and-alias — both exact identities carry the printed two instructions and catalog Spirit', () => {
    expect(card.oracleId).toBe('3db8466c-864f-48ba-b617-f2c863dfdcbd');
    expect(pin.sha256).toBe('4da93215102bbd43f1bc01e0ded2313ab4923995859e87e016e2a5481e09739a');
    expect(card.manaCost).toBe('{3}{W}');
    expect(card.types).toEqual(['Instant']);
    for (const oracleId of [card.oracleId, fixtureOracleId(card.name)]) {
      const def = interpretCard({ ...card, oracleId });
      expect(def.modeled).toBe(true);
      expect(def.unmodeledReasons).toEqual([]);
      expect(validateCardDefinition(def)).toEqual([]);
      expect(def.spellAbility?.targets).toEqual([]);
      expect(def.spellAbility?.effects).toEqual([
        {
          op: 'shareTokensWithChosenOpponent',
          spec: SPIRIT_1_1_FLYING,
          count: { kind: 'const', n: 3 },
        },
        { op: 'shareCreatureLifeWithChosenOpponent', amount: { kind: 'const', n: 2 } },
      ]);
    }
  });
  it('offering-normal-cast-independent-opponents — four mana buys Spirits for P2 and life for P3, with own creature counts', () => {
    const ctx = sharedOpponentPod();
    const object = castSharedOpponentSpell(ctx, card);
    expect(settleSharedOpponentSpell(ctx)).toBe(2);
    const spirits = ctx.state.battlefield.filter((permanent) => permanent.isToken);
    expect(spirits).toHaveLength(6);
    for (const id of ['P1', 'P2'])
      expect(
        spirits.filter((permanent) => permanent.ownerId === id && permanent.controllerId === id),
      ).toHaveLength(3);
    for (const spirit of spirits)
      expect(computeCharacteristics(ctx, spirit)).toMatchObject({
        types: ['Creature'],
        subtypes: ['Spirit'],
        colors: ['W'],
        power: 1,
        toughness: 1,
        keywords: ['flying'],
      });
    expect(ctx.state.players.map((player) => player.life)).toEqual([48, 40, 42, 40]);
    expect(playerById(ctx, 'P1').graveyard.some((entry) => entry.cardId === object.cardId)).toBe(
      true,
    );
  });
  it('offering-same-opponent-allowed — the second choice may name the first recipient again', () => {
    const ctx = sharedOpponentPod();
    castSharedOpponentSpell(ctx, card);
    expect(settleSharedOpponentSpell(ctx, ['P2', 'P2'])).toBe(2);
    expect(ctx.state.players.map((player) => player.life)).toEqual([48, 48, 40, 40]);
  });
  it('offering-tokens-precede-life-choice — all six Spirits exist before the fresh second choice and count for life', () => {
    const ctx = sharedOpponentPod();
    castSharedOpponentSpell(ctx, card);
    settleSharedOpponentSpell(ctx, ['P2', 'P2'], (_decision, index) => {
      expect(ctx.state.battlefield.filter((permanent) => permanent.isToken)).toHaveLength(
        index === 0 ? 0 : 6,
      );
      expect(ctx.state.players.map((player) => player.life)).toEqual([40, 40, 40, 40]);
    });
    expect(ctx.state.players.map((player) => player.life)).toEqual([48, 48, 40, 40]);
  });
  it('offering-choices-do-not-target — opponent hexproof never excludes a legal resolution choice', () => {
    const ctx = sharedOpponentPod();
    ctx.state.playerHexproofTurn = { P2: 5, P3: 5, P4: 5 };
    castSharedOpponentSpell(ctx, card);
    settleSharedOpponentSpell(ctx, ['P2', 'P3'], (decision) =>
      expect(decision.options.map((option) => option.description.slice(0, 2))).toEqual([
        'P2',
        'P3',
        'P4',
      ]),
    );
    expect(ctx.state.players.map((player) => player.life)).toEqual([48, 40, 42, 40]);
  });
  it('offering-lost-opponent-excluded — both fresh menus omit departed players', () => {
    const ctx = sharedOpponentPod();
    playerById(ctx, 'P4').hasLost = true;
    castSharedOpponentSpell(ctx, card);
    settleSharedOpponentSpell(ctx, ['P2', 'P3'], (decision) =>
      expect(decision.options.some((option) => option.description.startsWith('P4 '))).toBe(false),
    );
    expect(
      ctx.state.battlefield.filter(
        (permanent) => permanent.isToken && permanent.controllerId === 'P4',
      ),
    ).toEqual([]);
  });
  it('offering-instant-on-opponent-turn — the real normal cast is legal during another player main phase', () => {
    const ctx = sharedOpponentPod();
    ctx.state.currentTurnPlayer = 'P3';
    ctx.state.activePlayerIndex = 2;
    castSharedOpponentSpell(ctx, card);
    settleSharedOpponentSpell(ctx);
    expect(ctx.state.players.map((player) => player.life)).toEqual([48, 40, 42, 40]);
  });
  it('offering-needs-white-and-four-total — three total mana or four colorless cannot announce the spell', () => {
    for (const symbols of [
      ['W', 'C', 'C'],
      ['C', 'C', 'C', 'C'],
    ] as const) {
      const ctx = sharedOpponentPod();
      const object = conjure(ctx, 'P1', card, 'hand');
      addMana(
        playerById(ctx, 'P1'),
        symbols.map((symbol) => ({ symbol })),
      );
      expect(
        computePriorityOptions(ctx, playerById(ctx, 'P1')).some(
          (option) => (option.payload as { objectId?: string }).objectId === object.id,
        ),
      ).toBe(false);
    }
  });
  it('offering-creatures-count-by-controller — ownership and noncreature artifacts do not substitute for current creatures', () => {
    const ctx = sharedOpponentPod();
    const borrowed = ctx.state.battlefield.find((permanent) => permanent.controllerId === 'P4')!;
    changeController(ctx, borrowed, 'P3');
    spawn(ctx, 'P3', oracle({ name: 'Uncounted Relic', typeLine: 'Artifact' }));
    castSharedOpponentSpell(ctx, card);
    settleSharedOpponentSpell(ctx);
    expect(ctx.state.players.map((player) => player.life)).toEqual([48, 40, 44, 40]);
    expect(borrowed.ownerId).toBe('P4');
  });
  it('offering-recipient-token-replacement — only the chosen creator multiplier changes its own batch and later creature count', () => {
    const ctx = sharedOpponentPod();
    const doubler = oracle({ name: 'Independent Spirit Doubler', typeLine: 'Enchantment' });
    registerCustomDef(ctx, {
      ...interpretCard(doubler),
      ruleStatics: [{ kind: 'tokenCountMultiplier', multiplier: 2 }],
    });
    spawn(ctx, 'P2', doubler);
    castSharedOpponentSpell(ctx, card);
    settleSharedOpponentSpell(ctx, ['P2', 'P2']);
    expect(
      ctx.state.battlefield.filter(
        (permanent) => permanent.isToken && permanent.controllerId === 'P1',
      ),
    ).toHaveLength(3);
    expect(
      ctx.state.battlefield.filter(
        (permanent) => permanent.isToken && permanent.controllerId === 'P2',
      ),
    ).toHaveLength(6);
    expect(ctx.state.players.map((player) => player.life)).toEqual([48, 54, 40, 40]);
  });
});
