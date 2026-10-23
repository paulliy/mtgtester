/**
 * Resolution contract for `gainControlTarget`'s recipient union.
 *
 * Two disjoint ways to name who receives control: an ordinary player target slot chosen at
 * announcement (`{ targetPlayer }`), and the resolved-time `{ chooseOpponent: true }` flag used by
 * "an opponent gains control of …". Both the strict authoring shape and the runtime identity of
 * the gifted object are pinned here independently of any one card.
 */
import { describe, expect, it } from 'vitest';
import { interactionFor } from '../src/engine';
import { applyPriorityAction } from '../src/actions/apply';
import {
  computePriorityOptions,
  computeTargetOptions,
  type PriorityActionPayload,
} from '../src/actions/legal';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import type { Ability, TargetSpec } from '../src/cards/ability';
import type { CardDefinition } from '../src/cards/definition';
import { interpretCard } from '../src/cards/interpret';
import type { PendingDecision, DecisionOutcome } from '../src/decisions';
import { executeAbility } from '../src/effects/resolve';
import { activated, targetSlots, TAP } from '../src/cards/templates';
import { createGame } from '../src/state/game';
import { moveObject, playerById } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import {
  conjure,
  copies,
  forest,
  gameConfig,
  oracle,
  pump,
  registerCustomDef,
  spawn,
} from './fixtures';

const probe = () =>
  oracle({ name: 'Resolution Recipient Probe', typeLine: 'Artifact', manaCost: '{0}' });
const bear = () =>
  oracle({ name: 'Contract Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' });

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

const passFirst = (decision: PendingDecision): DecisionOutcome => ({
  index: Math.max(
    0,
    decision.options.findIndex((option) => option.type === 'pass'),
  ),
  targets: new Map(),
});

const isOpponentChoice = (decision: PendingDecision): boolean =>
  decision.options.some((option) => option.type === 'choosePlayer');

function choose(wanted: string): Answer {
  return (decision) => {
    if (!isOpponentChoice(decision)) return passFirst(decision);
    const index = decision.options.findIndex((option) => opponentId(option) === wanted);
    if (index < 0) throw new Error(`no opponent option ${wanted} in ${decision.prompt}`);
    return { index, targets: new Map() };
  };
}
function opponentId(option: PendingDecision['options'][number]) {
  const subject = option.presentation?.subjects[0];
  return subject?.kind === 'player' ? subject.playerId : undefined;
}

function activationOf(ctx: GameContext, playerId: string, objectId: string) {
  return computePriorityOptions(ctx, playerById(ctx, playerId)).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'activateAbility' && payload.objectId === objectId;
  });
}

const events = (ctx: GameContext, type: string) =>
  ctx.state.eventLog.filter((event) => event.type === type);

/** A definition whose single activation gives away its own source. */
function giftDefinition(recipient: unknown, targets: TargetSpec[] = []): CardDefinition {
  // The recipient is deliberately untyped here: this is the surface the strict validator guards,
  // so the malformed shapes below have to reach it as authored rather than as pre-typed noise.
  const ability = {
    kind: 'activated',
    targets,
    effects: [{ op: 'gainControlTarget', target: 'source', recipient }],
  } as unknown as Ability;
  return {
    ...interpretCard(probe()),
    activatedAbilities: [{ ...activated({ costs: [TAP], targets, effects: [] }), ability }],
  } as unknown as CardDefinition;
}

const GIFT = 'definition.activatedAbilities[0].ability.effects[0].recipient';

describe('gainControlTarget recipient resolution contract', () => {
  it('resolution-control-recipient-strict-recipient-shapes — one branch or the other, never both', () => {
    expect(validateCardDefinition(giftDefinition({ chooseOpponent: true }))).toEqual([]);
    expect(
      validateCardDefinition(giftDefinition({ targetPlayer: 0 }, [{ kind: 'player' }])),
    ).toEqual([]);
    // Neither branch named: an empty object is a mistake, never "the ability controller".
    expect(validateCardDefinition(giftDefinition({})).map((issue) => issue.path)).toContain(GIFT);
    for (const nonObject of [null, 'source', 42, true, []]) {
      expect(
        validateCardDefinition(giftDefinition(nonObject)).map((issue) => issue.path),
      ).toContain(GIFT);
    }
    // `chooseOpponent` is a boolean flag, not a value: false, a string and a number are all typos.
    for (const bad of [false, 'true', 1, 0, null, {}]) {
      expect(
        validateCardDefinition(giftDefinition({ chooseOpponent: bad })).map((issue) => issue.path),
      ).toContain(`${GIFT}.chooseOpponent`);
    }
    // Unknown keys, and both branches at once.
    expect(
      validateCardDefinition(giftDefinition({ chooseOpponent: true, extra: true })).map(
        (issue) => issue.path,
      ),
    ).toContain(GIFT);
    expect(
      validateCardDefinition(giftDefinition({ targetPlayer: 0, chooseOpponent: true })).map(
        (issue) => issue.path,
      ),
    ).toContain(GIFT);
    expect(
      validateCardDefinition(giftDefinition({ targetPlayer: 0, slot: 1 })).map(
        (issue) => issue.path,
      ),
    ).toContain(GIFT);
    // An impossible slot: the ability declares no player slot at all.
    expect(
      validateCardDefinition(giftDefinition({ targetPlayer: 0 })).map((issue) => issue.path),
    ).toContain(`${GIFT}.targetPlayer`);
    expect(
      validateCardDefinition(giftDefinition({ targetPlayer: 3 }, [{ kind: 'player' }])).map(
        (issue) => issue.path,
      ),
    ).toContain(`${GIFT}.targetPlayer`);
  });

  it('resolution-control-recipient-choose-opponent-announces-no-target — the recipient is not a target', () => {
    const ctx = pod('recipient-no-target');
    const self = spawn(ctx, 'P1', probe());
    registerCustomDef(ctx, giftDefinition({ chooseOpponent: true }));
    ctx.state.playerHexproofTurn = { P3: ctx.state.turnNumber };
    // A genuine "target opponent" slot would exclude the hexproof player; the printed text names
    // no target at all, so there is no slot to announce and no slot to check.
    expect(computeTargetOptions(ctx, { kind: 'player', controller: 'opponent' }, 'P1')).toEqual([
      'P2',
      'P4',
    ]);
    const option = activationOf(ctx, 'P1', self.id);
    expect(option).toBeDefined();
    expect(option!.targets ?? []).toHaveLength(0);
    pump(
      applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(self.tapped).toBe(true);
    const { decisions } = pump(resolveTopOfStack(ctx), choose('P3'));
    const menu = decisions.find(isOpponentChoice);
    expect(menu!.player).toBe('P1');
    // Every living opponent, hexproof or not, in seat order.
    expect(menu!.options.map(opponentId)).toEqual(['P2', 'P3', 'P4']);
    for (const option of menu!.options) expect(interactionFor(option)).toEqual({ kind: 'choice' });
    expect(menu!.options.every((entry) => entry.presentation?.subjects[0]?.kind === 'player')).toBe(
      true,
    );
    expect(self.controllerId).toBe('P3');
  });

  it('resolution-control-recipient-choose-opponent-excludes-the-chooser-and-lost-players — eligibility', () => {
    const ctx = pod('recipient-eligibility');
    const self = spawn(ctx, 'P1', probe());
    playerById(ctx, 'P4').hasLost = true;
    const { decisions } = pump(
      executeAbility(
        ctx,
        {
          id: self.id,
          cardId: self.cardId,
          name: self.name,
          oracleId: self.oracleId,
          controllerId: 'P1',
        },
        {
          kind: 'activated',
          targets: [],
          effects: [
            { op: 'gainControlTarget', target: 'source', recipient: { chooseOpponent: true } },
          ],
        },
        [],
      ),
      choose('P2'),
    );
    const menu = decisions.find(isOpponentChoice)!;
    expect(menu.player).toBe('P1');
    // P1 is the chooser, not a candidate; P4 has left the game and is not a player at all.
    expect(menu.options.map(opponentId)).toEqual(['P2', 'P3']);
    expect(self.controllerId).toBe('P2');
  });

  it('resolution-control-recipient-target-player-slot-is-unchanged — the announced branch still targets', () => {
    const ctx = pod('recipient-target-player');
    const slots = targetSlots({ opponent: { kind: 'player', controller: 'opponent' } });
    const self = spawn(ctx, 'P1', probe());
    registerCustomDef(ctx, giftDefinition({ targetPlayer: slots.slot.opponent }, slots.targets));
    ctx.state.playerHexproofTurn = { P3: ctx.state.turnNumber };
    const option = activationOf(ctx, 'P1', self.id);
    expect(option).toBeDefined();
    // An ordinary slot: announced, checked for hexproof, and chosen before the ability resolves.
    expect(option!.targets?.[0]?.options).toEqual(['P2', 'P4']);
    pump(
      applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, 'P4']]),
      }),
    );
    expect(self.controllerId).toBe('P1');
    pump(resolveTopOfStack(ctx));
    expect(self.controllerId).toBe('P4');
    expect(self.summoningSick).toBe(true);
  });

  it('resolution-control-recipient-omitted-recipient-is-the-ability-controller — default branch', () => {
    const ctx = pod('recipient-omitted');
    const target = spawn(ctx, 'P2', bear());
    expect(validateCardDefinition(giftDefinition(undefined))).toEqual([]);
    const { decisions } = pump(
      executeAbility(
        ctx,
        {
          cardId: target.cardId,
          oracleId: target.oracleId,
          name: target.name,
          controllerId: 'P1',
        },
        {
          kind: 'spell',
          targets: [{ kind: 'creature' }],
          effects: [{ op: 'gainControlTarget', target: 0 }],
        },
        [target.id],
      ),
    );
    expect(target.controllerId).toBe('P1');
    expect(target.controlChanges).toEqual([
      { controllerId: 'P1', duration: { kind: 'permanent' }, timestamp: 2 },
    ]);
    // No choice is surfaced: the omitted branch is not an offer, it is the controller itself.
    expect(decisions.some(isOpponentChoice)).toBe(false);
  });

  it('resolution-control-recipient-acts-on-the-exact-source-object — CR 400.7 identity', () => {
    const ctx = pod('recipient-source-identity');
    const giftSource: Ability = {
      kind: 'activated',
      targets: [],
      effects: [{ op: 'gainControlTarget', target: 'source', recipient: { chooseOpponent: true } }],
    };
    const decoy = spawn(ctx, 'P1', oracle({ name: 'Unrelated Artifact', typeLine: 'Artifact' }));

    const stillHere = spawn(ctx, 'P1', probe());
    void pump(
      executeAbility(
        ctx,
        {
          id: stillHere.id,
          cardId: stillHere.cardId,
          name: stillHere.name,
          oracleId: stillHere.oracleId,
          controllerId: 'P1',
        },
        giftSource,
        [],
      ),
      choose('P2'),
    );
    expect(stillHere.controllerId).toBe('P2');

    // The named object leaves the battlefield: nothing else is gifted in its place.
    const gone = spawn(ctx, 'P1', oracle({ name: 'Departing Artifact', typeLine: 'Artifact' }));
    const goneSource = {
      id: gone.id,
      cardId: gone.cardId,
      name: gone.name,
      oracleId: gone.oracleId,
      controllerId: 'P1' as const,
    };
    void pump(moveObject(ctx, gone, { zone: 'exile' }));
    const beforeGains = events(ctx, 'gainControl').length;
    void pump(executeAbility(ctx, goneSource, giftSource, []), choose('P2'));
    expect(events(ctx, 'gainControl')).toHaveLength(beforeGains);
    expect(decoy.controllerId).toBe('P1');

    // A blinked artifact is a NEW object (CR 400.7); the old incarnation's id names nothing.
    const blinked = spawn(ctx, 'P1', oracle({ name: 'Blinking Artifact', typeLine: 'Artifact' }));
    const blinkSource = {
      id: blinked.id,
      cardId: blinked.cardId,
      name: blinked.name,
      oracleId: blinked.oracleId,
      controllerId: 'P1' as const,
    };
    const exiled = pump(moveObject(ctx, blinked, { zone: 'exile' })).value;
    expect(exiled).not.toBeNull();
    const returned = pump(moveObject(ctx, exiled!, { zone: 'battlefield' })).value;
    expect(returned).not.toBeNull();
    expect(ctx.state.exile.some((entry) => entry.cardId === blinked.cardId)).toBe(false);
    const incarnation = ctx.state.battlefield.find(
      (entry) => entry.cardId === blinked.cardId && entry.id !== blinked.id,
    );
    expect(incarnation).toBeDefined();
    expect(incarnation!.id).not.toBe(blinkSource.id);
    void pump(executeAbility(ctx, blinkSource, giftSource, []), choose('P2'));
    expect(incarnation!.controllerId).toBe('P1');
    expect(events(ctx, 'gainControl')).toHaveLength(beforeGains);
    expect(decoy.controllerId).toBe('P1');
  });

  it('resolution-control-recipient-same-controller-records-a-fresh-effect-timestamp — CR 613.7', () => {
    const ctx = pod('recipient-same-controller');
    const alreadyOurs = spawn(ctx, 'P2', bear());
    const sameController = {
      cardId: alreadyOurs.cardId,
      oracleId: alreadyOurs.oracleId,
      name: alreadyOurs.name,
      controllerId: 'P1' as const,
    };
    const stampBefore = ctx.state.nextTimestamp;
    void pump(
      executeAbility(
        ctx,
        sameController,
        {
          kind: 'spell',
          targets: [{ kind: 'creature' }],
          effects: [{ op: 'gainControlTarget', target: 0, recipient: { chooseOpponent: true } }],
        },
        [alreadyOurs.id],
        undefined,
      ),
      choose('P2'),
    );
    const records = alreadyOurs.controlChanges ?? [];
    expect(records).toHaveLength(1);
    expect(records[0]!.controllerId).toBe('P2');
    expect(records[0]!.duration).toEqual({ kind: 'permanent' });
    expect(records[0]!.timestamp).toBeGreaterThanOrEqual(stampBefore);
    // Naming the controller the permanent already answers to is NOT a transition (CR 613.7):
    // the layer timestamp is untouched, and no sickness or combat removal happens.
    expect(alreadyOurs.controllerId).toBe('P2');
    expect(alreadyOurs.summoningSick).toBe(false);
    // Nothing is announced for a no-op transition either.
    expect(events(ctx, 'gainControl')).toHaveLength(0);
  });

  it('resolution-control-recipient-actual-transition-sets-sickness-and-leaves-combat — CR 302.6/506.4', () => {
    const ctx = pod('recipient-transition');
    const attacker = spawn(ctx, 'P2', bear());
    attacker.attacking = 'P1';
    attacker.statuses = ['attacking'];
    attacker.summoningSick = false;
    const stampBefore = ctx.state.nextTimestamp;
    void pump(
      executeAbility(
        ctx,
        {
          cardId: attacker.cardId,
          oracleId: attacker.oracleId,
          name: attacker.name,
          controllerId: 'P1',
        },
        {
          kind: 'spell',
          targets: [{ kind: 'creature' }],
          effects: [{ op: 'gainControlTarget', target: 0, recipient: { chooseOpponent: true } }],
        },
        [attacker.id],
      ),
      choose('P3'),
    );
    expect(attacker.controllerId).toBe('P3');
    expect(attacker.summoningSick).toBe(true);
    expect(attacker.attacking).toBeNull();
    expect(attacker.statuses).not.toContain('attacking');
    expect(events(ctx, 'gainControl')).toHaveLength(1);
    expect(
      (events(ctx, 'gainControl')[0]?.payload as { newController: string }).newController,
    ).toBe('P3');
    // Even a transition records a fresh effect timestamp of its own.
    expect((attacker.controlChanges ?? [])[0]!.timestamp).toBeGreaterThanOrEqual(stampBefore);
  });

  it('resolution-control-recipient-target-player-who-left-the-game-does-nothing — CR 608.2h', () => {
    const ctx = pod('recipient-target-dead');
    const slots = targetSlots({ opponent: { kind: 'player', controller: 'opponent' } });
    const self = spawn(ctx, 'P1', probe());
    registerCustomDef(ctx, giftDefinition({ targetPlayer: slots.slot.opponent }, slots.targets));
    const option = activationOf(ctx, 'P1', self.id);
    expect(option?.targets?.[0]?.options).toContain('P3');
    pump(
      applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, 'P3']]),
      }),
    );
    // P3 left the game after the ability was announced but before it resolved.
    playerById(ctx, 'P3').hasLost = true;
    pump(resolveTopOfStack(ctx));
    expect(self.controllerId).toBe('P1');
    expect(events(ctx, 'gainControl')).toHaveLength(0);
  });

  it('resolution-control-recipient-no-opponent-left-leaves-the-rest-of-the-resolution-intact — CR 608.2h', () => {
    const ctx = pod('recipient-no-opponents');
    const source = spawn(ctx, 'P1', probe());
    playerById(ctx, 'P2').hasLost = true;
    playerById(ctx, 'P3').hasLost = true;
    playerById(ctx, 'P4').hasLost = true;
    const survivor = spawn(ctx, 'P2', bear());
    void pump(
      executeAbility(
        ctx,
        {
          cardId: survivor.cardId,
          oracleId: survivor.oracleId,
          name: survivor.name,
          controllerId: 'P1',
        },
        {
          kind: 'spell',
          targets: [{ kind: 'creature' }],
          // A gift of the source that cannot be made is skipped, not a stall.
          effects: [
            { op: 'draw', count: { kind: 'const', n: 1 } },
            { op: 'gainControlTarget', target: 0, recipient: { chooseOpponent: true } },
          ],
        },
        [survivor.id],
      ),
      passFirst,
    );
    // Nothing was offered (there is no eligible opponent), and nothing was taken.
    expect(source.controllerId).toBe('P1');
    expect(survivor.controllerId).toBe('P2');
    expect(events(ctx, 'draw')).toHaveLength(1);
    expect(events(ctx, 'gainControl')).toHaveLength(0);
  });

  it('resolution-control-recipient-still-draws-from-the-ability-controllers-library — the chooser is the ability controller', () => {
    const ctx = pod('recipient-controller-library');
    const source = spawn(ctx, 'P1', probe());
    const libraryCard = conjure(
      ctx,
      'P1',
      oracle({ name: 'Contract Find', typeLine: 'Instant' }),
      'library',
    );
    playerById(ctx, 'P1').library = [libraryCard];
    playerById(ctx, 'P1').hand.length = 0;
    void pump(
      executeAbility(
        ctx,
        {
          id: source.id,
          cardId: source.cardId,
          name: source.name,
          oracleId: source.oracleId,
          controllerId: 'P1',
        },
        {
          kind: 'activated',
          targets: [],
          effects: [
            {
              op: 'searchLibrary',
              filter: { kind: 'allOf', of: [] },
              destinations: [{ zone: 'hand' }],
              allowFailToFind: true,
            },
            { op: 'gainControlTarget', target: 'source', recipient: { chooseOpponent: true } },
          ],
        },
        [],
      ),
      choose('P2'),
    );
    expect(playerById(ctx, 'P1').hand.map((card) => card.name)).toEqual(['Contract Find']);
    expect(source.controllerId).toBe('P2');
  });
});
