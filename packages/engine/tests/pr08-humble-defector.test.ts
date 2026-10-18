/**
 * PR08 card coverage: Humble Defector
 * (docs/plans/card-coverage-chunks.md — control changes and multiplayer choices).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import type { CardDefinition } from '../src/cards/definition';
import type { PendingDecision, DecisionOutcome } from '../src/decisions';
import { executeAbility } from '../src/effects/resolve';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { moveObject, playerById } from '../src/state/objects';
import { phaseOutControlledPermanents } from '../src/state/phasing';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import { addMana } from '../src/mana/pool';
import { conjure, copies, forest, gameConfig, oracle, spawn, pump } from './fixtures';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}
const pins = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/coverage-pr08-oracle.json'), 'utf8'),
  ) as PinnedFixture
).cards;
const humblePin = pins.find((pin) => pin.card.name === 'Humble Defector');
if (humblePin === undefined) throw new Error('missing pinned Oracle fixture for Humble Defector');

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

type Answer = (decision: PendingDecision, count: number) => DecisionOutcome;

function priorityOptions(ctx: GameContext, playerId: string) {
  return computePriorityOptions(ctx, playerById(ctx, playerId));
}

function activationOf(ctx: GameContext, playerId: string, source: EnginePermanent) {
  return priorityOptions(ctx, playerId).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'activateAbility' && payload.objectId === source.id;
  });
}

function activationTargetsOffered(
  ctx: GameContext,
  playerId: string,
  source: EnginePermanent,
): string[] {
  const option = activationOf(ctx, playerId, source);
  return option?.targets?.[0]?.options.filter((id): id is string => typeof id === 'string') ?? [];
}

function takeAction(
  ctx: GameContext,
  playerId: string,
  payload: PriorityActionPayload,
  answer?: Answer,
  targets: ReadonlyMap<number, string> = new Map(),
) {
  return pump(
    applyPriorityAction(ctx, playerById(ctx, playerId), payload, { index: 0, targets }),
    answer,
  );
}

function resolveTop(ctx: GameContext, answer?: Answer) {
  return pump(resolveTopOfStack(ctx), answer);
}

function turnOfPlayer(ctx: GameContext, playerId: string): void {
  ctx.state.currentTurnPlayer = playerId;
  ctx.state.activePlayerIndex = Number(playerId.slice(1)) - 1;
}

const events = (ctx: GameContext, type: string) =>
  ctx.state.eventLog.filter((event) => event.type === type);

function announceOnStack(ctx: GameContext, self: EnginePermanent): void {
  const option = activationOf(ctx, 'P1', self);
  expect(option).toBeDefined();
  takeAction(ctx, 'P1', option!.payload as PriorityActionPayload, undefined, new Map([[0, 'P3']]));
  expect(self.tapped).toBe(true);
  expect(ctx.state.stack).toHaveLength(1);
}

describe('Humble Defector', () => {
  it('humble-defector-pinned-oracle-supported — humble defector pinned oracle supported', () => {
    expect(humblePin.sha256).toBe(
      'ab20c63164ea397b563967afac0fda59a57eedf602b7e4ecc3845c3cb092a3dc',
    );
    expect(humblePin.card.oracleText).toBe(
      '{T}: Draw two cards. Target opponent gains control of this creature. Activate only during your turn.',
    );
    for (const card of [
      humblePin.card,
      { ...humblePin.card, oracleId: fixtureOracleId('Humble Defector') },
    ]) {
      const def = interpretCard(card);
      expect(def.unmodeledReasons, card.oracleId).toEqual([]);
      expect(def.modeled, card.oracleId).toBe(true);
      const [ability] = def.activatedAbilities;
      expect(ability).toMatchObject({
        costs: [{ kind: 'tap' }],
        timing: 'yourTurn',
        ability: {
          targets: [{ kind: 'player', controller: 'opponent' }],
          effects: [
            { op: 'draw', count: { kind: 'const', n: 2 } },
            { op: 'gainControlTarget', target: 'source', recipient: { targetPlayer: 0 } },
          ],
        },
      });
      expect(validateCardDefinition(def)).toEqual([]);
    }
  });

  it('humble-defector-draw-then-transfer — humble defector draw then transfer', () => {
    const ctx = pod('humble-transfer');
    const self = spawn(ctx, 'P1', humblePin.card);
    const before = {
      P1: playerById(ctx, 'P1').hand.length,
      P3: playerById(ctx, 'P3').hand.length,
    };
    const offered = activationTargetsOffered(ctx, 'P1', self);
    expect(offered).toEqual(expect.arrayContaining(['P2', 'P3', 'P4']));
    expect(offered).not.toContain('P1');
    announceOnStack(ctx, self);
    resolveTop(ctx);
    expect(playerById(ctx, 'P1').hand).toHaveLength(before.P1 + 2);
    expect(playerById(ctx, 'P3').hand).toHaveLength(before.P3);
    expect(self.controllerId).toBe('P3');
    expect(self.summoningSick).toBe(true);
    expect(events(ctx, 'gainControl')).toHaveLength(1);
    expect(
      (events(ctx, 'gainControl')[0]?.payload as { newController: string }).newController,
    ).toBe('P3');
  });

  it('humble-defector-your-turn-timing — humble defector your turn timing', () => {
    const ctx = pod('humble-timing');
    const self = spawn(ctx, 'P1', humblePin.card);
    ctx.state.phase = 'combat';
    ctx.state.step = 'combatDamage';
    const bolt = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Lab Bolt',
        typeLine: 'Instant',
        manaCost: '{G}',
        oracleText: 'Draw a card.',
      }),
      'hand',
    );
    addMana(playerById(ctx, 'P1'), [{ symbol: 'G' }]);
    const castOption = priorityOptions(ctx, 'P1').find((entry) => {
      const payload = entry.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === bolt.id;
    });
    expect(castOption).toBeDefined();
    takeAction(ctx, 'P1', castOption!.payload as PriorityActionPayload);
    expect(ctx.state.stack).toHaveLength(1);
    expect(activationOf(ctx, 'P1', self)).toBeDefined();
    ctx.state.activePlayerIndex = 1;
    expect(activationOf(ctx, 'P1', self)).toBeUndefined();
    ctx.state.activePlayerIndex = 0;
    expect(activationOf(ctx, 'P1', self)).toBeDefined();
  });

  it('humble-defector-activation-rejections — humble defector activation rejections', () => {
    const ctx = pod('humble-rejections');
    const sick = spawn(ctx, 'P1', humblePin.card, { summoningSick: true });
    expect(activationOf(ctx, 'P1', sick)).toBeUndefined();
    sick.summoningSick = false;
    expect(activationOf(ctx, 'P1', sick)).toBeDefined();

    const tapped = spawn(ctx, 'P1', humblePin.card, { tapped: true });
    expect(activationOf(ctx, 'P1', tapped)).toBeUndefined();
  });

  it('humble-defector-illegal-opponent-fizzles — humble defector illegal opponent fizzles', () => {
    const ctx = pod('humble-fizzle');
    const self = spawn(ctx, 'P1', humblePin.card);
    const beforeHand = playerById(ctx, 'P1').hand.length;
    announceOnStack(ctx, self);
    playerById(ctx, 'P3').hasLost = true;
    resolveTop(ctx);
    expect(events(ctx, 'fizzle')).toHaveLength(1);
    expect(events(ctx, 'draw')).toHaveLength(0);
    expect(events(ctx, 'gainControl')).toHaveLength(0);
    expect(playerById(ctx, 'P1').hand).toHaveLength(beforeHand);
    expect(self.controllerId).toBe('P1');
    expect(self.tapped).toBe(true);
  });

  it('humble-defector-source-leaves-still-draws — humble defector source leaves still draws', () => {
    const ctx = pod('humble-leaves');
    const self = spawn(ctx, 'P1', humblePin.card);
    const beforeHand = playerById(ctx, 'P1').hand.length;
    const beforeOpponent = playerById(ctx, 'P3').hand.length;
    announceOnStack(ctx, self);
    void pump(moveObject(ctx, self, { zone: 'exile' }));
    expect(ctx.state.battlefield.some((entry) => entry.id === self.id)).toBe(false);
    resolveTop(ctx);
    expect(playerById(ctx, 'P1').hand).toHaveLength(beforeHand + 2);
    expect(playerById(ctx, 'P3').hand).toHaveLength(beforeOpponent);
    expect(events(ctx, 'gainControl')).toHaveLength(0);
  });

  it('humble-defector-blink-no-transfer — humble defector blink no transfer', () => {
    const ctx = pod('humble-blink');
    const self = spawn(ctx, 'P1', humblePin.card);
    announceOnStack(ctx, self);
    void pump(moveObject(ctx, self, { zone: 'exile' }));
    const returned = pump(moveObject(ctx, self, { zone: 'battlefield' })).value;
    expect(returned).not.toBeNull();
    const beforeHand = playerById(ctx, 'P1').hand.length;
    resolveTop(ctx);
    expect(playerById(ctx, 'P1').hand).toHaveLength(beforeHand + 2);
    const incarnation = ctx.state.battlefield.find(
      (entry) => entry.cardId === self.cardId && entry.id !== self.id,
    );
    expect(incarnation).toBeDefined();
    expect(incarnation!.id).not.toBe(self.id);
    expect(incarnation!.controllerId).toBe('P1');
    expect(events(ctx, 'gainControl')).toHaveLength(0);
  });

  it('humble-defector-source-phases — an absent phased-out source still draws without transferring control', () => {
    const ctx = pod('humble-phases');
    const self = spawn(ctx, 'P1', humblePin.card);
    const before = playerById(ctx, 'P1').hand.length;
    announceOnStack(ctx, self);
    phaseOutControlledPermanents(ctx, 'P1');
    resolveTop(ctx);
    expect(playerById(ctx, 'P1').hand).toHaveLength(before + 2);
    expect(
      ctx.state.phasedOut?.find((record) => record.permanent.id === self.id)?.permanent
        .controllerId,
    ).toBe('P1');
    expect(events(ctx, 'gainControl')).toHaveLength(0);
  });

  it('humble-defector-new-controller-activates — humble defector new controller activates', () => {
    const ctx = pod('humble-handoff');
    const self = spawn(ctx, 'P1', humblePin.card);
    announceOnStack(ctx, self);
    resolveTop(ctx);
    expect(self.controllerId).toBe('P3');
    turnOfPlayer(ctx, 'P3');
    self.tapped = false;
    self.summoningSick = false;
    expect(activationOf(ctx, 'P3', self)).toBeDefined();
    expect(activationOf(ctx, 'P1', self)).toBeUndefined();
  });

  it('humble-defector-default-controller — humble defector default controller', () => {
    const ctx = pod('humble-default');
    const bear = spawn(
      ctx,
      'P2',
      oracle({ name: 'Test Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
    );
    const def: CardDefinition = {
      ...interpretCard(
        oracle({
          name: 'Gain Probe',
          typeLine: 'Sorcery',
          manaCost: '{0}',
          oracleText: 'You gain control of target creature.',
        }),
      ),
      modeled: true,
      unmodeledReasons: [],
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'creature' }],
        effects: [{ op: 'gainControlTarget', target: 0 }],
      },
    };
    expect(validateCardDefinition(def)).toEqual([]);
    void pump(
      executeAbility(
        ctx,
        { cardId: bear.cardId, oracleId: bear.oracleId, name: bear.name, controllerId: 'P1' },
        {
          kind: 'spell',
          targets: [{ kind: 'creature' }],
          effects: [{ op: 'gainControlTarget', target: 0 }],
        },
        [bear.id],
      ),
    );
    expect(bear.controllerId).toBe('P1');
    expect(events(ctx, 'gainControl')).toHaveLength(1);
    expect(
      (events(ctx, 'gainControl')[0]?.payload as { newController: string }).newController,
    ).toBe('P1');
  });

  it('humble-defector-recipient-validation — humble defector recipient validation', () => {
    const base = () => {
      const def = {
        ...interpretCard(oracle({ name: 'Recipient probe', typeLine: 'Sorcery', manaCost: '{0}' })),
        modeled: true,
        unmodeledReasons: [],
        spellAbility: {
          kind: 'spell',
          targets: [{ kind: 'creature' }],
          effects: [{ op: 'draw', count: { kind: 'const', n: 1 } }],
          description: 'Draw a card',
        },
      };
      return def;
    };
    const definition = (activatedAbilities: unknown) =>
      ({
        ...base(),
        activatedAbilities,
      }) as unknown as CardDefinition;
    const wrapped = (recipient: unknown) => [
      {
        costs: [{ kind: 'tap' }],
        timing: 'yourTurn',
        ability: {
          kind: 'activated',
          targets: [{ kind: 'player', controller: 'opponent' }],
          effects: [
            { op: 'draw', count: { kind: 'const', n: 2 } },
            { op: 'gainControlTarget', target: 'source', recipient },
          ],
        },
      },
    ];
    const AT = 'definition.activatedAbilities[0].ability.effects[1].recipient';

    expect(validateCardDefinition(definition(wrapped({ targetPlayer: 0 })))).toEqual([]);
    expect(validateCardDefinition(definition(wrapped(null))).map((issue) => issue.path)).toContain(
      AT,
    );
    expect(
      validateCardDefinition(definition(wrapped('source'))).map((issue) => issue.path),
    ).toContain(AT);
    expect(
      validateCardDefinition(definition(wrapped({ targetPlayer: '0' }))).map((issue) => issue.path),
    ).toContain(`${AT}.targetPlayer`);
    expect(
      validateCardDefinition(definition(wrapped({ targetPlayer: 9 }))).map((issue) => issue.path),
    ).toContain(`${AT}.targetPlayer`);
    expect(
      validateCardDefinition(definition(wrapped({ slot: 0 }))).map((issue) => issue.path),
    ).toContain(AT);
    const creatureSlotIssues = validateCardDefinition(
      definition([
        {
          costs: [{ kind: 'tap' }],
          timing: 'yourTurn',
          ability: {
            kind: 'activated',
            targets: [{ kind: 'creature' }],
            effects: [
              {
                op: 'gainControlTarget',
                target: 'source',
                recipient: { targetPlayer: 0 },
              },
            ],
          },
        },
      ]),
    );
    expect(creatureSlotIssues.map((issue) => issue.path)).toContain(
      'definition.activatedAbilities[0].ability.effects[0].recipient.targetPlayer',
    );
  });
});
