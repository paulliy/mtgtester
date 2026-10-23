/**
 * PR08 casting tests: Humble Defector normal {1}{R} casting and recipient primitive.
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
import { endUntilEotEffects, executeAbility } from '../src/effects/resolve';
import { interpretCard } from '../src/cards/interpret';
import { changeController, playerById, controlledBy } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { createGame } from '../src/state/game';
import { addMana } from '../src/mana/pool';
import { runPrioritySequence } from '../src/turn/priority';
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

function castOptionFor(ctx: GameContext, playerId: string, cardId: string) {
  return priorityOptions(ctx, playerId).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === cardId;
  });
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
  return pump(
    runPrioritySequence(ctx),
    answer ??
      ((decision) => ({
        index: Math.max(
          0,
          decision.options.findIndex((option) => option.type === 'pass'),
        ),
        targets: new Map(),
      })),
  );
}

function turnOfPlayer(ctx: GameContext, playerId: string): void {
  ctx.state.currentTurnPlayer = playerId;
  ctx.state.activePlayerIndex = Number(playerId.slice(1)) - 1;
}

function manaTotal(player: ReturnType<typeof playerById>) {
  return Object.values(player.manaPool).reduce((sum, value) => sum + (value ?? 0), 0);
}

describe('Humble Defector casting and recipient', () => {
  it('humble-defector-normal-cast-pays-one-generic-one-red-and-resolves — normal cast pays one generic one red and resolves', () => {
    const ctx = pod('humble-normal-cast');
    const player = playerById(ctx, 'P1');
    const card = conjure(ctx, 'P1', humblePin.card, 'hand');
    addMana(player, [{ symbol: 'C' }, { symbol: 'R' }]);
    const option = castOptionFor(ctx, 'P1', card.id);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(ctx.state.stack).toHaveLength(1);
    expect(manaTotal(player)).toBe(0);
    resolveTop(ctx);
    const permanent = ctx.state.battlefield.find((entry) => entry.cardId === card.cardId);
    expect(permanent).toBeDefined();
    expect(permanent!.summoningSick).toBe(true);
    expect(
      ctx.state.eventLog.some(
        (event) => event.type === 'castSpell' && event.payload['name'] === 'Humble Defector',
      ),
    ).toBe(true);
  });

  it('humble-defector-normal-cast-unavailable-without-red — normal cast unavailable without red', () => {
    const ctx = pod('humble-no-red');
    const player = playerById(ctx, 'P1');
    const card = conjure(ctx, 'P1', humblePin.card, 'hand');
    addMana(player, [{ symbol: 'C' }, { symbol: 'C' }]);
    expect(castOptionFor(ctx, 'P1', card.id)).toBeUndefined();
  });

  it('humble-defector-normal-cast-rejects-wrong-turn-main-and-combat — normal cast rejects wrong turn main and combat', () => {
    const ctx = pod('humble-wrong-turn');
    const player = playerById(ctx, 'P1');
    const card = conjure(ctx, 'P1', humblePin.card, 'hand');
    addMana(player, [{ symbol: 'C' }, { symbol: 'R' }]);
    ctx.state.phase = 'combat';
    expect(castOptionFor(ctx, 'P1', card.id)).toBeUndefined();
    ctx.state.phase = 'precombatMain';
    turnOfPlayer(ctx, 'P2');
    expect(castOptionFor(ctx, 'P1', card.id)).toBeUndefined();
  });

  it('humble-defector-activates-after-ready-cast-and-transfers-to-p3 — activates after ready cast and transfers to p3', () => {
    const ctx = pod('humble-activate');
    const caster = playerById(ctx, 'P1');
    const card = conjure(ctx, 'P1', humblePin.card, 'hand');
    addMana(caster, [{ symbol: 'C' }, { symbol: 'R' }]);
    const option = castOptionFor(ctx, 'P1', card.id);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    resolveTop(ctx);
    const self = ctx.state.battlefield.find((entry) => entry.cardId === card.cardId)!;
    self.summoningSick = false;
    self.tapped = false;
    const beforeCaster = caster.hand.length;
    const beforeOpponent = playerById(ctx, 'P3').hand.length;
    const activation = priorityOptions(ctx, 'P1').find((entry) => {
      const payload = entry.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === self.id;
    });
    expect(activation).toBeDefined();
    takeAction(
      ctx,
      'P1',
      activation!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, 'P3']]),
    );
    expect(self.tapped).toBe(true);
    expect(ctx.state.stack).toHaveLength(1);
    resolveTop(ctx);
    expect(caster.hand.length).toBe(beforeCaster + 2);
    expect(playerById(ctx, 'P3').hand.length).toBe(beforeOpponent);
    expect(self.controllerId).toBe('P3');
  });

  it.each(['P2', 'P3'])(
    'humble-defector-pending-ability-retains-original-controller-and-target — temporary controller %s does not replace the pending ability controller or mask the permanent transfer',
    (temporaryController) => {
      const ctx = pod('humble-pending');
      const caster = playerById(ctx, 'P1');
      const card = conjure(ctx, 'P1', humblePin.card, 'hand');
      addMana(caster, [{ symbol: 'C' }, { symbol: 'R' }]);
      const castOpt = castOptionFor(ctx, 'P1', card.id);
      takeAction(ctx, 'P1', castOpt!.payload as PriorityActionPayload);
      resolveTop(ctx);
      const self = ctx.state.battlefield.find((entry) => entry.cardId === card.cardId)!;
      self.summoningSick = false;
      self.tapped = false;
      const activation = priorityOptions(ctx, 'P1').find((entry) => {
        const payload = entry.payload as PriorityActionPayload;
        return payload.kind === 'activateAbility' && payload.objectId === self.id;
      });
      takeAction(
        ctx,
        'P1',
        activation!.payload as PriorityActionPayload,
        undefined,
        new Map([[0, 'P3']]),
      );
      const beforeCaster = caster.hand.length;
      const beforeTarget = playerById(ctx, 'P3').hand.length;
      const sourceId = self.id;
      changeController(ctx, self, temporaryController, { kind: 'untilEndOfTurn' });
      resolveTop(ctx);
      expect(caster.hand.length).toBe(beforeCaster + 2);
      expect(playerById(ctx, 'P3').hand.length).toBe(beforeTarget);
      expect(self.id).toBe(sourceId);
      expect(self.controllerId).toBe('P3');
      endUntilEotEffects(ctx);
      expect(self.controllerId).toBe('P3');
    },
  );

  it('humble-defector-gain-control-target-recipient-undefined-defaults-controller — gain control target recipient undefined defaults controller', () => {
    const ctx = pod('humble-recipient-default');
    const bear = spawn(
      ctx,
      'P2',
      oracle({ name: 'Test Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
    );
    const before = playerById(ctx, 'P2').hand.length;
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
    expect(playerById(ctx, 'P2').hand.length).toBe(before);
  });

  it('humble-defector-gain-control-target-recipient-preserves-until-eot-and-same-controller — gain control target recipient preserves until eot and same controller', () => {
    const ctx = pod('humble-recipient-slot0');
    const bear = spawn(
      ctx,
      'P3',
      oracle({ name: 'Test Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
    );
    changeController(ctx, bear, 'P2');
    changeController(ctx, bear, 'P1', { kind: 'untilEndOfTurn' });
    void pump(
      executeAbility(
        ctx,
        { cardId: bear.cardId, oracleId: bear.oracleId, name: bear.name, controllerId: 'P1' },
        {
          kind: 'spell',
          targets: [{ kind: 'creature' }, { kind: 'player' }],
          effects: [
            {
              op: 'gainControlTarget',
              target: 0,
              recipient: { targetPlayer: 1 },
              duration: 'untilEndOfTurn',
            },
          ],
        },
        [bear.id, 'P1'],
      ),
    );
    expect(bear.controllerId).toBe('P1');
    // recipient already current controller records same-controller control change
    const records = bear.controlChanges ?? [];
    expect(records).toHaveLength(3);
    expect(controlledBy(bear)).toBe('P1');
    // expiry primitive present
    expect(records.some((record) => record.duration.kind === 'untilEndOfTurn')).toBe(true);
    endUntilEotEffects(ctx);
    expect(bear.controllerId).toBe('P2');
    expect(bear.controlChanges).toHaveLength(1);
  });

  it('humble-defector-malformed-recipient-validation — malformed recipient validation', () => {
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

    const cases: Array<[unknown, string | null]> = [
      [wrapped({ targetPlayer: 0, extra: true }), AT],
      [wrapped({ targetPlayer: -1 }), `${AT}.targetPlayer`],
      [wrapped({ targetPlayer: 1.5 }), `${AT}.targetPlayer`],
      [wrapped({ targetPlayer: Number.MAX_SAFE_INTEGER + 1 }), `${AT}.targetPlayer`],
      [wrapped({ targetPlayer: 9 }), `${AT}.targetPlayer`],
      [wrapped({}), AT],
      [wrapped('source'), AT],
      [wrapped(null), AT],
    ];
    for (const [abilities, path] of cases) {
      const issues = validateCardDefinition(definition(abilities));
      expect(issues.map((issue) => issue.path)).toContain(path);
    }
    // non-player scope: targetPlayer points at a creature slot
    const creatureIssues = validateCardDefinition(
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
    expect(creatureIssues.map((issue) => issue.path)).toContain(
      'definition.activatedAbilities[0].ability.effects[0].recipient.targetPlayer',
    );
  });
});
