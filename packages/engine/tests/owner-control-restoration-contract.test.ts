/**
 * Contract regression for the `regainControlOfOwnCreatures` executor in
 * `src/effects/resolve.ts` — the primitive behind Trostani Disciple's and Alicia Masters, Skilled
 * Sculptor's "each player gains control of all creatures they own".
 *
 * The card here is a GENERIC fixture with its own definition, not Alicia and not any override:
 * the thing under test is the executor, so it must not be able to regress together with the card
 * that first needed it. The behavior tests drive it through a real cast, real legality, real
 * priority, the real stack and the real step-trigger queue.
 *
 * The fixture's printed text is exactly what the primitive implements, and the authored definition
 * clears precisely that one reason — the same one-for-one rule `applyOverride` applies to a real
 * override. If the text ever stopped producing that reason, `restorerDef` fails instead of
 * quietly continuing to claim support the engine cannot back up. Nothing here writes a source file,
 * shells out, or runs another test runner.
 */
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import type { CardDefinition } from '../src/cards/definition';
import { interpretCard } from '../src/cards/interpret';
import { allOf, ofType, YOURS } from '../src/cards/selector';
import type { PendingDecision, DecisionOutcome } from '../src/decisions';
import { computeCharacteristics } from '../src/effects/continuous';
import { endUntilEotEffects, executeAbility } from '../src/effects/resolve';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { changeController, controlledBy, playerById } from '../src/state/objects';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { beginEndStep } from '../src/turn/turn';
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

/**
 * A generic restorer: nothing about Alicia Masters is needed to exercise the executor. Its
 * definition is authored here because the generic interpreter cannot read the effect the printed
 * text describes — that is precisely why the primitive exists.
 */
const RESTORER_TEXT =
  'At the beginning of your end step, each player gains control of all creatures they own.';

/** The fragment of the interpreter's one unparsed reason that this fixture's trigger handles. */
const RESTORER_REASON_FRAGMENT = 'each player gains control of all creatures they own';

const restorerCard = (): OracleCard =>
  oracle({
    name: 'Ownership Restorer',
    typeLine: 'Legendary Creature — Test Sage',
    manaCost: '{3}',
    oracleText: RESTORER_TEXT,
  });

const restoreEffects = [{ op: 'regainControlOfOwnCreatures' } as const];

const restorerTrigger: CardDefinition['triggers'][number] = {
  kind: 'triggered',
  trigger: { when: 'endStep', player: 'you' },
  targets: [],
  effects: [...restoreEffects],
  description: RESTORER_TEXT,
};

/**
 * Author the printed line with the real primitive, clearing exactly the one reason the interpreter
 * reported for it. `modeled` is then a consequence of that clearing, not an assertion bolted on:
 * an empty `unmodeledReasons: []` written straight into a definition is how a fixture ends up
 * claiming support it never earned.
 */
function restorerDef(card: OracleCard): CardDefinition {
  const interpreted = interpretCard(card);
  const handled = interpreted.unmodeledReasons.filter((reason) =>
    reason.includes(RESTORER_REASON_FRAGMENT),
  );
  expect(handled, 'the interpreter reports the restoration line as unparsed').toHaveLength(1);
  expect(
    interpreted.unmodeledReasons,
    'this fixture authors every line the interpreter could not read',
  ).toHaveLength(1);
  const remaining = interpreted.unmodeledReasons.filter(
    (reason) => !reason.includes(RESTORER_REASON_FRAGMENT),
  );
  return {
    ...interpreted,
    triggers: [restorerTrigger],
    unmodeledReasons: remaining,
    modeled: remaining.length === 0,
  };
}

const bear = (name: string): OracleCard =>
  oracle({ name, typeLine: 'Creature — Test', manaCost: '{1}' });

const relic = (name: string): OracleCard =>
  oracle({ name, typeLine: 'Artifact', manaCost: '{2}', power: null, toughness: null });

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

type Answer = (decision: PendingDecision, count: number) => DecisionOutcome;

function settle(ctx: GameContext, answer?: Answer) {
  return pump(runPrioritySequence(ctx), (decision, count) => {
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    if (pass >= 0) return { index: pass, targets: new Map() };
    return answer?.(decision, count) ?? { index: 0, targets: new Map() };
  });
}

/** Put a permanent in play under `controllerId` while `ownerId` keeps ownership of it. */
function spawnStolen(
  ctx: GameContext,
  controllerId: string,
  ownerId: string,
  card: OracleCard,
): EnginePermanent {
  const perm = spawn(ctx, controllerId, card);
  perm.ownerId = ownerId;
  return perm;
}

/** Register a card carrying the controller-dependent static "Artifacts you control are creatures". */
function registerKeeper(ctx: GameContext, name: string): OracleCard {
  const card = bear(name);
  const def = interpretCard(card);
  registerCustomDef(ctx, {
    ...def,
    staticEffects: [
      ...def.staticEffects,
      { affects: allOf(ofType('Artifact'), YOURS), op: { layer: 4, addTypes: ['Creature'] } },
    ],
  });
  return card;
}

/** Cast the restorer normally and leave it in play for the end step. */
function castRestorer(ctx: GameContext): EnginePermanent {
  const card = restorerCard();
  const def = restorerDef(card);
  registerCustomDef(ctx, def);
  const object = conjure(ctx, 'P1', card, 'hand');
  addMana(playerById(ctx, 'P1'), [{ symbol: 'C' }, { symbol: 'C' }, { symbol: 'C' }]);
  const option = computePriorityOptions(ctx, playerById(ctx, 'P1')).find((entry) => {
    const payload = entry.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === object.id;
  });
  expect(option, 'the generic restorer is castable from hand').toBeDefined();
  expect(option!.targets ?? [], 'the printed ability names no target').toHaveLength(0);
  expect(validateCardDefinition(def)).toEqual([]);
  pump(
    applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  expect(ctx.state.stack).toHaveLength(1);
  settle(ctx);
  const permanent = ctx.state.battlefield.find((entry) => entry.cardId === object.cardId);
  expect(permanent, 'the restorer resolved onto the battlefield').toBeDefined();
  expect(permanent!.controllerId).toBe('P1');
  return permanent!;
}

/** Resolve the primitive directly, for scenarios that are about the executor alone. */
function runRestore(ctx: GameContext, source: EnginePermanent): void {
  pump(
    executeAbility(
      ctx,
      {
        cardId: source.cardId,
        name: source.name,
        oracleId: source.oracleId,
        controllerId: source.controllerId,
      },
      restorerTrigger,
      [],
    ),
  );
}

describe('regainControlOfOwnCreatures — owner control restoration contract', () => {
  it('owner-control-restoration-fixture-definition-models-every-line-it-prints', () => {
    // The generic fixture authors its own IR, so prove that IR is honest rather than blank: the
    // interpreter genuinely cannot read the line, the authored trigger genuinely carries the real
    // primitive, and clearing that one reason is the only thing that makes it modeled.
    const card = restorerCard();
    const interpreted = interpretCard(card);
    expect(interpreted.unmodeledReasons).toHaveLength(1);
    expect(interpreted.modeled).toBe(false);
    expect(interpreted.unmodeledReasons[0]).toContain(RESTORER_REASON_FRAGMENT);

    const def = restorerDef(card);
    expect(def.triggers).toEqual([restorerTrigger]);
    expect(def.triggers[0]?.effects).toEqual([{ op: 'regainControlOfOwnCreatures' }]);
    expect(def.unmodeledReasons).toEqual([]);
    expect(def.modeled).toBe(true);
    expect(validateCardDefinition(def)).toEqual([]);
  });

  it('owner-control-restoration-normal-cast-then-end-step-returns-every-players-own-creatures', () => {
    const ctx = pod('owner-control-normal');
    const restorer = castRestorer(ctx);
    const stolen = spawnStolen(ctx, 'P1', 'P2', bear('Borrowed Bear'));
    const stolenFromThird = spawnStolen(ctx, 'P2', 'P3', bear('Third Party Fox'));
    const alreadyMine = spawn(ctx, 'P1', bear('My Own Grizzly'));

    // Two temporary grants sit under the restoration's permanent one; both expire at cleanup.
    changeController(ctx, stolen, 'P1', { kind: 'untilEndOfTurn' });
    changeController(ctx, stolen, 'P2', { kind: 'untilEndOfTurn' });

    beginEndStep(ctx);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    expect(ctx.state.pendingTriggers[0]?.controllerId).toBe('P1');
    settle(ctx);

    expect(stolen.controllerId).toBe('P2');
    expect(stolenFromThird.controllerId).toBe('P3');
    expect(alreadyMine.controllerId).toBe('P1');
    expect(stolen.summoningSick).toBe(true);
    expect(alreadyMine.summoningSick).toBe(false);

    for (const perm of [stolen, stolenFromThird, alreadyMine]) {
      expect(perm.controlChanges?.at(-1), perm.name).toMatchObject({
        controllerId: perm.ownerId,
        duration: { kind: 'permanent' },
      });
    }
    endUntilEotEffects(ctx);
    expect(controlledBy(stolen)).toBe('P2');
    expect(controlledBy(stolenFromThird)).toBe('P3');
    expect(controlledBy(alreadyMine)).toBe('P1');
    expect(stolen.controlChanges).toHaveLength(1);
    expect(restorer.controllerId).toBe('P1');
  });

  it('owner-control-restoration-grants-a-fresh-permanent-record-to-a-creature-its-owner-already-controls', () => {
    const ctx = pod('owner-control-mask');
    const source = spawn(ctx, 'P1', restorerCard());
    registerCustomDef(ctx, restorerDef(restorerCard()));
    const held = spawn(ctx, 'P1', bear('Already Mine'));

    // A realistic reachable history: the creature was taken for the rest of the turn and handed
    // back before the end step, so an older temporary record naming a DIFFERENT player still
    // survives when the older one expires.
    changeController(ctx, held, 'P2', { kind: 'untilEndOfTurn' });
    changeController(ctx, held, 'P1', { kind: 'untilEndOfTurn' });
    const stampBefore = ctx.state.nextTimestamp;

    runRestore(ctx, source);

    // The owner already controlled it, and still receives a grant: a fresh PERMANENT record
    // carrying a fresh effect timestamp, past everything it sits on.
    const grant = held.controlChanges?.at(-1);
    expect(held.controllerId).toBe('P1');
    expect(grant).toMatchObject({ controllerId: 'P1', duration: { kind: 'permanent' } });
    expect(grant?.timestamp).toBeGreaterThanOrEqual(stampBefore);
    expect(held.controlChanges).toHaveLength(3);
    // Nothing about the creature itself changed by the GRANT: handing a permanent to the player
    // who already controls it is not a controller transition (CR 613.7 sets no layer timestamp,
    // and CR 302.6/506.4 need none). The two earlier setup transitions are what set sickness.
    expect(held.summoningSick).toBe(true);

    // At cleanup the two temporary records expire underneath, and the permanent one holds.
    endUntilEotEffects(ctx);
    expect(controlledBy(held)).toBe('P1');
    expect(held.controllerId).toBe('P1');
    expect(held.controlChanges).toHaveLength(1);
    expect(held.controlChanges?.[0]?.duration).toEqual({ kind: 'permanent' });
  });

  it('owner-control-restoration-freezes-the-creature-set-before-any-control-change', () => {
    const ctx = pod('owner-control-frozen');
    const source = spawn(ctx, 'P1', restorerCard());
    registerCustomDef(ctx, restorerDef(restorerCard()));

    // "Artifacts you control are creatures" on a carrier that is itself stolen: once the sweep
    // hands that carrier back to its owner, the static follows it and a plain artifact the
    // carrier used to cover BECOMES a creature — part way through the very same effect.
    const keeper = spawnStolen(ctx, 'P2', 'P1', registerKeeper(ctx, 'Contract Keeper'));
    const plainRelic = spawnStolen(ctx, 'P1', 'P2', relic('Plain Relic'));
    const secondKeeper = spawnStolen(ctx, 'P2', 'P1', registerKeeper(ctx, 'Second Keeper'));
    expect(computeCharacteristics(ctx, plainRelic).types.includes('Creature')).toBe(false);

    // Battlefield order puts the carriers first, so a per-iteration characteristics read would
    // see the relic turn into a creature mid-sweep.
    expect(ctx.state.battlefield.map((perm) => perm.name)).toEqual([
      'Ownership Restorer',
      'Contract Keeper',
      'Plain Relic',
      'Second Keeper',
    ]);

    runRestore(ctx, source);

    expect(keeper.controllerId).toBe('P1');
    expect(secondKeeper.controllerId).toBe('P1');
    expect(plainRelic.controllerId).toBe('P1');
    expect(plainRelic.controlChanges).toBeUndefined();
    // And it really did become a creature during the sweep — precisely the read a per-iteration
    // characteristics check would have taken and acted on.
    expect(computeCharacteristics(ctx, plainRelic).types.includes('Creature')).toBe(true);
  });

  it('owner-control-restoration-reaches-only-creatures-and-only-the-moment-it-resolves', () => {
    const ctx = pod('owner-control-scope');
    const source = spawn(ctx, 'P1', restorerCard());
    registerCustomDef(ctx, restorerDef(restorerCard()));

    const stolenLand = spawnStolen(ctx, 'P1', 'P2', forest());
    const stolenRelic = spawnStolen(ctx, 'P1', 'P2', relic('Borrowed Relic'));
    const stolenCreature = spawnStolen(ctx, 'P1', 'P2', bear('Borrowed Bear'));
    const latecomer = spawn(ctx, 'P1', bear('Already Here'));
    latecomer.ownerId = 'P2';

    runRestore(ctx, source);

    expect(stolenLand.controllerId).toBe('P1');
    expect(stolenRelic.controllerId).toBe('P1');
    expect(stolenLand.controlChanges).toBeUndefined();
    expect(stolenRelic.controlChanges).toBeUndefined();
    expect(stolenCreature.controllerId).toBe('P2');

    // An arrival after the fact is a different game state; the effect already chose its set.
    const afterResolution = spawnStolen(ctx, 'P1', 'P2', bear('Late Arrival'));
    runRestore(ctx, source);
    expect(afterResolution.controllerId).toBe('P2');
    expect(latecomer.controllerId).toBe('P2');
  });

  it('owner-control-restoration-does-not-hand-a-creature-to-a-departed-owner', () => {
    const ctx = pod('owner-control-departed');
    const source = spawn(ctx, 'P1', restorerCard());
    registerCustomDef(ctx, restorerDef(restorerCard()));
    const orphan = spawnStolen(ctx, 'P1', 'P3', bear('Orphan'));
    playerById(ctx, 'P3').hasLost = true;

    runRestore(ctx, source);

    // "Each player" means each player still in the game: control never moves to a seat that has
    // left, and no record is written naming one (refreshControlEffects would drop it anyway).
    expect(orphan.controllerId).toBe('P1');
    expect(orphan.controlChanges).toBeUndefined();
  });

  it('owner-control-restoration-is-your-end-step-only', () => {
    const ctx = pod('owner-control-not-yours');
    const restorer = castRestorer(ctx);
    const stolen = spawnStolen(ctx, 'P1', 'P2', bear('Borrowed Bear'));

    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    beginEndStep(ctx);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    settle(ctx);
    expect(stolen.controllerId).toBe('P1');
    expect(restorer.controllerId).toBe('P1');
  });
});
