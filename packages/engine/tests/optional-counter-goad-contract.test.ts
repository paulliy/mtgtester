/**
 * Generic contract for `eachPlayerMayPutCountersAndGoad` (PR08.13, Agitator Ant) as a SPELL
 * effect, independent of the production card.
 *
 * The probe is an ordinary zero-cost instant whose registered `spellAbility` is the primitive
 * itself, cast through `computePriorityOptions`/`applyPriorityAction` on the real stack. The
 * caster is P1 while P3 is the active player, so the APNAP choice order the primitive must
 * follow is provably a property of the ACTIVE player, not the caster.
 */
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import type { CardDefinition } from '../src/cards/definition';
import { interpretCard } from '../src/cards/interpret';
import { defineCard } from '../src/cards/overrides';
import { spell, triggered } from '../src/cards/templates';
import { constant } from '../src/cards/value';
import { computeCharacteristics } from '../src/effects/continuous';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import type { EnginePermanent, EngineStackObject, GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, forest, gameConfig, oracle, pump, registerDef, spawn } from './fixtures';

const PROBE = (count = 2) =>
  oracle({
    name: 'Independent counter-goad probe ' + count,
    typeLine: 'Instant',
    manaCost: '{0}',
    oracleText:
      'Each player may put ' +
      count +
      ' +1/+1 counters on a creature they control. Goad each creature that had counters put on it this way.',
  });
for (const count of [0, 1, 2]) {
  const card = PROBE(count);
  defineCard(card.oracleId, card.name, ['unrecognized rules text: "' + card.oracleText + '"'], {
    spellAbility: spell({
      effects: [
        { op: 'eachPlayerMayPutCountersAndGoad', counter: '+1/+1', count: constant(count) },
      ],
      description: card.oracleText,
    }),
  });
}
/** The independent fixture's printed instruction and IR use exactly the same count. */
function probeDefinition(ctx: GameContext, count: number): CardDefinition {
  if (![0, 1, 2].includes(count)) throw Error('Unfunded probe count');
  const definition = registerDef(ctx, PROBE(count));
  expect(definition.modeled).toBe(true);
  expect(definition.unmodeledReasons).toEqual([]);
  return definition;
}

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 5;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

type Answer = (decision: PendingDecision, count: number) => DecisionOutcome;

function turnOfPlayer(ctx: GameContext, playerId: string): void {
  ctx.state.currentTurnPlayer = playerId;
  ctx.state.activePlayerIndex = Number(playerId.slice(1)) - 1;
}

function bear(ctx: GameContext, controller: string, name: string): EnginePermanent {
  return spawn(ctx, controller, oracle({ name, typeLine: 'Creature — Bear', manaCost: '{1}' }));
}

const goaders = (perm: EnginePermanent): string[] =>
  (perm.goadedBy ?? []).map((entry) => entry.goaderId);

const countersOn = (perm: EnginePermanent): number => perm.counters['+1/+1'] ?? 0;

const countersLog = (ctx: GameContext) =>
  ctx.state.eventLog.filter((event) => event.type === 'counters');

const permanentChoices = (ctx: GameContext) =>
  ctx.state.eventLog
    .filter((event) => event.type === 'permanentChoice')
    .map((event) => ({ acter: event.actorSeat, name: event.payload['name'] ?? null }));

/**
 * Answer the primitive's per-player `chooseCard` menus in the planned choice order. Each plan
 * maps the choosing player onto a creature they control, or null to decline. The callback
 * asserts the menu's creature-only scope, the final decline option, the absence of any raw
 * card payload, and that no counter has moved while any choice is still open (CR 608.2d).
 */
function menuAnswers(
  ctx: GameContext,
  placedCount: number,
  chosen: Record<string, string | null>,
): Answer {
  const planned = Object.entries(chosen);
  return (decision) => {
    expect(decision.decisionType).toBe('general');
    const plan = planned.shift();
    expect(plan, `a menu for ${decision.player} was not planned`).toBeDefined();
    expect(plan![0], `planned chooser for ${decision.player}`).toBe(decision.player);
    // In production the asking source is the whole stack entry description, which by
    // construction starts with the probe's name.
    expect(decision.prompt.startsWith('Independent counter-goad probe')).toBe(true);
    expect(
      decision.prompt.includes(
        `put ${placedCount} +1/+1 counters on a creature you control, or put none.`,
      ),
    ).toBe(true);
    expect(decision.options.at(-1)?.description).toBe('Put no counters');
    expect(
      decision.options.every(
        (option) => option.payload === undefined && option.targets === undefined,
      ),
      'no raw card payload on the choice menu',
    ).toBe(true);
    // While any choice is open, no counter has moved and no goad exists (CR 608.2d).
    for (const perm of ctx.state.battlefield) {
      expect(perm.counters['+1/+1'] ?? 0, perm.name).toBe(0);
      expect(perm.goadedBy, perm.name).toBeUndefined();
    }
    if (plan![1] === null) return { index: decision.options.length - 1, targets: new Map() };
    // Only the chooser's OWN CREATURES are offered.
    const offered = decision.options
      .slice(0, decision.options.length - 1)
      .map((option) => option.description.replace(`Put ${placedCount} +1/+1 counters on `, ''));
    expect(offered).toEqual(
      ctx.state.battlefield
        .filter(
          (perm) =>
            perm.controllerId === decision.player &&
            computeCharacteristics(ctx, perm).types.includes('Creature'),
        )
        .map((perm) => perm.name),
    );
    const index = decision.options.findIndex(
      (option) => option.description === `Put ${placedCount} +1/+1 counters on ${plan![1]}`,
    );
    expect(index, `a choice for ${plan![1]}`).toBeGreaterThan(-1);
    return { index, targets: new Map() };
  };
}

/**
 * Cast the probe through the real menu for its printed {0} cost, resolve it through real
 * priority, and answer the primitive's menus with `answer`. Returns true once the resolution
 * is complete.
 */
function castProbe(ctx: GameContext, count: number, answer: Answer): void {
  const card = conjure(ctx, 'P1', PROBE(count), 'hand');
  ctx.defs.set(card.oracleId, probeDefinition(ctx, count));
  const option = computePriorityOptions(ctx, playerById(ctx, 'P1')).find((entry) => {
    const payload = entry.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === card.id;
  });
  expect(option, 'normal zero-cost cast offered').toBeDefined();
  pump(
    applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  expect(ctx.state.stack).toHaveLength(1);
  expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
  pump(runPrioritySequence(ctx), (decision, innerCount) => {
    const pass = decision.options.findIndex((entry) => entry.type === 'pass');
    if (pass >= 0) return { index: pass, targets: new Map() };
    return answer(decision, innerCount);
  });
  expect(ctx.state.stack).toHaveLength(0);
}

const sumpCard = () =>
  oracle({
    name: 'Counter Sump',
    typeLine: 'Enchantment',
    oracleText:
      'If one or more counters would be put on a permanent you control, no counters are put on it instead.',
    manaCost: '{2}',
    power: null,
    toughness: null,
  });

/** Register a carrier that zeroes +1/+1 counter placements on ITS controller's permanents. */
function createCounterSump(ctx: GameContext): void {
  const replacement: CardDefinition['ruleStatics'] = [
    {
      kind: 'counterPlacementReplacement',
      filter: { kind: 'controller', who: 'you' },
      multiplier: 0,
      addition: 0,
    },
  ];
  const printed = sumpCard();
  defineCard(
    printed.oracleId,
    printed.name,
    ['unrecognized rules text: "' + printed.oracleText + '"'],
    { ruleStatics: replacement },
  );
  const definition = registerDef(ctx, printed);
  expect(definition.unmodeledReasons).toEqual([]);
}

const watcherCard = (byYou = false) =>
  oracle({
    name: byYou ? 'Counters Placer Eye' : 'Counters Batch Eye',
    oracleText: byYou
      ? 'Whenever you put one or more counters on a creature, you gain 1 life.'
      : 'Whenever one or more counters are put on one or more creatures, draw a card for each creature that had counters put on it this way.',
    typeLine: 'Enchantment',
    manaCost: '{2}',
    power: null,
    toughness: null,
  });

/**
 * A zero-cost instant kept IN HAND (never cast) during resolution: with nothing available the
 * players' priority is auto-passed and a waiting trigger resolves with no surfaced decision,
 * so this witness keeps one real decision surfaced while the trigger waits.
 */
const witnessCard = () =>
  oracle({
    name: 'Life Witness',
    typeLine: 'Instant',
    manaCost: '{0}',
    oracleText: 'You gain 1 life.',
  });

/** Register the aggregate watcher: one firing for a whole simultaneous batch of placements. */
function registerBatchWatcher(): void {
  const printed = watcherCard();
  defineCard(
    printed.oracleId,
    printed.name,
    ['unrecognized rules text: "' + printed.oracleText + '"'],
    {
      triggers: [
        triggered(
          {
            when: 'countersPut',
            subject: { kind: 'permanent', selector: { kind: 'type', value: 'Creature' } },
            aggregate: true,
          },
          { effects: [{ op: 'draw', count: { kind: 'triggerCount' } }] },
        ),
      ],
    },
  );
}

/** Register the placer-bound watcher: fires only when ITS controller puts counters. */
function registerByYouWatcher(ctx: GameContext): void {
  const definition = registerDef(ctx, watcherCard(true));
  expect(definition.modeled).toBe(true);
  expect(definition.unmodeledReasons).toEqual([]);
}

describe('eachPlayerMayPutCountersAndGoad as a spell effect', () => {
  it('counter-goad-contract-spell-authoring-is-clean — the op validates as a targetless instant effect', () => {
    const ctx = pod('counter-goad-valid');
    expect(validateCardDefinition(probeDefinition(ctx, 2))).toEqual([]);
  });
  it('counter-goad-contract-invalid-counter-name — the effect rejects empty and nontext counter names', () => {
    const ctx = pod('counter-goad-invalid-counter');
    const definition = probeDefinition(ctx, 2);
    for (const counter of ['', false, 7]) {
      const malformed = {
        ...definition,
        spellAbility: {
          ...definition.spellAbility!,
          effects: [{ op: 'eachPlayerMayPutCountersAndGoad', counter, count: constant(2) }],
        },
      } as unknown as CardDefinition;
      expect(
        validateCardDefinition(malformed).some((issue) => issue.path.endsWith('.counter')),
      ).toBe(true);
    }
  });

  it('counter-goad-contract-apnap-from-the-active-player — cast by P1 while P3 is ACTIVE, the menus come P3-P4-P1-P2, and a caster-declined menu still goads what a later player chose', () => {
    const ctx = pod('counter-goad-apnap');
    turnOfPlayer(ctx, 'P3');
    const p3Bear = bear(ctx, 'P3', 'P3 Bear');
    const p4Bear = bear(ctx, 'P4', 'P4 Bear');
    const myBear = bear(ctx, 'P1', 'P1 Bear');
    const theirBear = bear(ctx, 'P2', 'P2 Bear');

    const menus: string[] = [];
    const answer = menuAnswers(ctx, 2, {
      P3: null,
      P4: p4Bear.name,
      P1: myBear.name,
      P2: theirBear.name,
    });
    castProbe(ctx, 2, (decision) => {
      menus.push(decision.player);
      // The caster-P1 menu is a REAL chooser menu with real options: only P1's own creatures.
      if (decision.player === 'P1') {
        expect(decision.options.slice(0, -1).map((entry) => entry.description)).toEqual([
          `Put 2 +1/+1 counters on ${myBear.name}`,
        ]);
      }
      return answer(decision, 0);
    });

    expect(menus).toEqual(['P3', 'P4', 'P1', 'P2']);
    // Every surviving placement went to the chooser's own creature; the ACTIVE player's decline
    // named nothing and placed nothing.
    expect(countersOn(p3Bear)).toBe(0);
    expect(p3Bear.goadedBy).toBeUndefined();
    for (const perm of [p4Bear, myBear, theirBear]) {
      expect(countersOn(perm)).toBe(2);
    }
    // The goad is always applied by the spell's CONTROLLER (the caster P1), not the chooser —
    // even for a creature the active player P3's neighbor chose.
    expect(goaders(p4Bear)).toEqual(['P1']);
    expect(goaders(myBear)).toEqual(['P1']);
    expect(goaders(theirBear)).toEqual(['P1']);
  });

  it.each([0, 1, 2])(
    'counter-goad-contract-count-%s — after all choices, that many counters land and the goad follows only a positive placement',
    (placedCount) => {
      const ctx = pod(`counter-goad-count-${placedCount}`);
      const myBear = bear(ctx, 'P1', 'P1 Bear');
      const theirBear = bear(ctx, 'P2', 'P2 Bear');

      castProbe(ctx, placedCount, menuAnswers(ctx, placedCount, { P1: null, P2: theirBear.name }));

      expect(countersOn(theirBear)).toBe(placedCount);
      if (placedCount > 0) {
        expect(theirBear.counterTimestamps?.['+1/+1']).toBeGreaterThan(0);
        expect(goaders(theirBear)).toEqual(['P1']);
        expect(countersLog(ctx)).toHaveLength(1);
      } else {
        // A zero count still asks every question, but nothing moves and nothing is goaded.
        expect(theirBear.counterTimestamps?.['+1/+1']).toBeUndefined();
        expect(goaders(theirBear)).toEqual([]);
        expect(countersLog(ctx)).toEqual([]);
      }
      expect(countersOn(myBear)).toBe(0);
      expect(myBear.goadedBy).toBeUndefined();
      // The caster's decline is still published, with no object (druidPurification precedent).
      expect(permanentChoices(ctx)).toEqual([
        { acter: 'P1', name: null },
        { acter: 'P2', name: theirBear.name },
      ]);
    },
  );

  it('counter-goad-contract-lost-player-skipped — a lost seat is not asked at all', () => {
    const ctx = pod('counter-goad-lost');
    turnOfPlayer(ctx, 'P3');
    playerById(ctx, 'P4').hasLost = true;
    const p3Bear = bear(ctx, 'P3', 'P3 Bear');
    const myBear = bear(ctx, 'P1', 'P1 Bear');
    const theirBear = bear(ctx, 'P2', 'P2 Bear');

    const menus: string[] = [];
    const answer = menuAnswers(ctx, 2, {
      P3: p3Bear.name,
      P1: myBear.name,
      P2: theirBear.name,
    });
    castProbe(ctx, 2, (decision) => {
      menus.push(decision.player);
      // A departed seat is never handed a menu, so the plan names exactly P3, P1, P2.
      return answer(decision, 0);
    });
    // APNAP order from P3 skips the departed P4 entirely.
    expect(menus).toEqual(['P3', 'P1', 'P2']);
    expect(countersOn(p3Bear)).toBe(2);
    expect(countersOn(myBear)).toBe(2);
    expect(countersOn(theirBear)).toBe(2);
    expect(goaders(myBear)).toEqual(['P1']);
  });

  it('counter-goad-contract-aggregate-watcher-sees-one-batch — one batched countersPut event, ONE aggregate firing with triggerCount 2, not two separate events', () => {
    const ctx = pod('counter-goad-aggregate');
    registerBatchWatcher();
    spawn(ctx, 'P3', watcherCard());
    const myBear = bear(ctx, 'P1', 'P1 Bear');
    const theirBear = bear(ctx, 'P2', 'P2 Bear');
    const p3HandBefore = playerById(ctx, 'P3').hand.length;

    // Cast the spell through the real stack, then resolve it with the answerer below: the
    // waiting watcher firing is inspected on the stack at the first post-resolution decision.
    const card = conjure(ctx, 'P1', PROBE(), 'hand');
    ctx.defs.set(card.oracleId, probeDefinition(ctx, 2));
    const option = computePriorityOptions(ctx, playerById(ctx, 'P1')).find((entry) => {
      const payload = entry.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === card.id;
    });
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    // The witness is conjured into a hand that must not collide with the probe's registered
    // definition, so it is named and registered before they provably share nothing.
    conjure(ctx, 'P1', witnessCard(), 'hand');
    const answer = menuAnswers(ctx, 2, { P1: myBear.name, P2: theirBear.name });
    // The waiting trigger is put on the stack by the pre-priority checkpoint (CR 117.5) before
    // the next decision surfaces, so the firing is observed there; the queue itself is drained
    // before anyone answers priority again.
    let firing: EngineStackObject[] = [];
    pump(runPrioritySequence(ctx), (decision) => {
      const pass = decision.options.findIndex((entry) => entry.type === 'pass');
      if (pass < 0) return answer(decision, 0);
      if (firing.length === 0) {
        firing = ctx.state.stack.filter((entry) => entry.kind === 'triggeredAbility');
      }
      return { index: pass, targets: new Map() };
    });
    expect(ctx.state.stack).toHaveLength(0);
    // ONE waiting firing for the WHOLE batch: both placements in a single stack object whose
    // scope carries the batch size (two separate events would have waited as two abilities).
    expect(firing, 'the whole batch waited as ONE triggered ability').toHaveLength(1);
    expect(firing[0]?.triggerScope?.['triggerCount']).toBe(2);
    // "that many cards" is the batch size, not a per-placement draw.
    expect(
      playerById(ctx, 'P3').hand.length,
      'the aggregate watcher drew triggerCount = 2 cards',
    ).toBe(p3HandBefore + 2);
  });

  it('counter-goad-contract-by-you-binds-the-actual-placer — each row names the player who put the counters, so a "you put" watcher fires on its controller placement only', () => {
    const ctx = pod('counter-goad-by-you');
    registerByYouWatcher(ctx);
    spawn(ctx, 'P2', watcherCard(true));
    const myBear = bear(ctx, 'P1', 'P1 Bear');
    const theirBear = bear(ctx, 'P2', 'P2 Bear');
    const watchersLife = playerById(ctx, 'P2').life;

    castProbe(ctx, 2, menuAnswers(ctx, 2, { P1: myBear.name, P2: theirBear.name }));

    // Both placements happened, goaded by the caster.
    expect(countersOn(myBear)).toBe(2);
    expect(countersOn(theirBear)).toBe(2);
    expect(goaders(theirBear)).toEqual(['P1']);
    // The P2 watcher fired for exactly one row — the one whose placing player is its own
    // controller. P1's row did not reach it.
    expect(playerById(ctx, 'P2').life).toBe(watchersLife + 1);
  });

  it('counter-goad-contract-decline-and-self-restriction — the caster decline excludes its own creature, leaving the later choose to goad', () => {
    const ctx = pod('counter-goad-decline');
    const myBear = bear(ctx, 'P1', 'P1 Bear');
    const theirBear = bear(ctx, 'P2', 'P2 Bear');

    castProbe(ctx, 2, menuAnswers(ctx, 2, { P1: null, P2: theirBear.name }));

    expect(countersOn(myBear)).toBe(0);
    expect(myBear.goadedBy).toBeUndefined();
    expect(countersOn(theirBear)).toBe(2);
    expect(goaders(theirBear)).toEqual(['P1']);
    // The goad never lands on the caster's untouched creature.
    expect(countersLog(ctx)).toHaveLength(1);
    expect(permanentChoices(ctx)).toEqual([
      { acter: 'P1', name: null },
      { acter: 'P2', name: theirBear.name },
    ]);
  });

  it('counter-goad-contract-doubling-season-multiplier — a controller-wide doubling replacement grows the placement, and the goad still lands', () => {
    const ctx = pod('counter-goad-doubling');
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Coupled Growth',
        typeLine: 'Enchantment',
        manaCost: '{3}{G}',
        power: null,
        toughness: null,
        oracleText:
          'If an effect would create one or more tokens under your control, it creates twice that many of those tokens instead.\nIf an effect would put one or more counters on a permanent you control, it puts twice that many of those counters on that permanent instead.',
      }),
    );
    const myBear = bear(ctx, 'P1', 'P1 Bear');
    const theirBear = bear(ctx, 'P2', 'P2 Bear');

    castProbe(ctx, 2, menuAnswers(ctx, 2, { P1: myBear.name, P2: theirBear.name }));

    expect(countersOn(myBear)).toBe(4);
    expect(myBear.counterTimestamps?.['+1/+1']).toBeGreaterThan(0);
    expect(goaders(myBear)).toEqual(['P1']);
    // The doubling belongs to P1: P2's placement is unmodified.
    expect(countersOn(theirBear)).toBe(2);
    expect(goaders(theirBear)).toEqual(['P1']);
  });

  it('counter-goad-contract-replacement-to-zero-logs-and-never-goads — a placement adjusted to zero is logged as its 0 and names no goad', () => {
    const ctx = pod('counter-goad-zero');
    createCounterSump(ctx);
    spawn(ctx, 'P2', sumpCard());
    const myBear = bear(ctx, 'P1', 'P1 Bear');
    const theirBear = bear(ctx, 'P2', 'P2 Bear');

    castProbe(ctx, 2, menuAnswers(ctx, 2, { P1: myBear.name, P2: theirBear.name }));

    expect(countersOn(myBear)).toBe(2);
    expect(goaders(myBear)).toEqual(['P1']);
    // P2's creature confronted a zeroing replacement: nothing was put, so nothing is goaded.
    expect(countersOn(theirBear)).toBe(0);
    expect(theirBear.counters).not.toHaveProperty('+1/+1');
    expect(theirBear.counterTimestamps?.['+1/+1']).toBeUndefined();
    expect(goaders(theirBear)).toEqual([]);
    const zeroed = countersLog(ctx).filter((event) => event.payload['target'] === theirBear.name);
    expect(zeroed).toHaveLength(1);
    expect(zeroed[0]?.payload['added']).toBe(0);
    expect(zeroed[0]?.payload['total']).toBe(0);
  });

  it('counter-goad-contract-threshold-triggers-and-timestamps-preserved — a batched placement reuses the existing counter mechanics rather than a side channel', () => {
    const ctx = pod('counter-goad-threshold');
    const thresholdBear = () =>
      oracle({
        name: 'Watching Bear',
        typeLine: 'Creature — Bear',
        manaCost: '{1}',
        oracleText:
          'Whenever the number of +1/+1 counters on this creature becomes two or more, you gain 3 life.',
      });
    const watcherDef = interpretCard(thresholdBear());
    expect(watcherDef.unmodeledReasons).toEqual([
      'unrecognized rules text: "' + thresholdBear().oracleText + '"',
    ]);
    defineCard(watcherDef.oracleId, watcherDef.name, watcherDef.unmodeledReasons, {
      counterThresholdTriggers: [
        {
          counter: '+1/+1',
          threshold: 2,
          ability: {
            kind: 'triggered',
            targets: [],
            effects: [{ op: 'gainLife', amount: { kind: 'const', n: 3 } }],
            description: 'Watching Bear life trigger',
          },
        },
      ],
    });
    const watched = spawn(ctx, 'P2', thresholdBear());
    const theirBear = bear(ctx, 'P2', 'P2 Bear');

    const answer = menuAnswers(ctx, 2, { P2: watched.name });
    // A real cast option (witness never cast) keeps a priority decision surfaced while the
    // threshold trigger waits: with nothing available, every player is auto-passed and the
    // waiting trigger would resolve with no surfaced decision (fixtures pump §5.4).
    conjure(ctx, 'P1', witnessCard(), 'hand');
    const card = conjure(ctx, 'P1', PROBE(), 'hand');
    ctx.defs.set(card.oracleId, probeDefinition(ctx, 2));
    const option = computePriorityOptions(ctx, playerById(ctx, 'P1')).find((entry) => {
      const payload = entry.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === card.id;
    });
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    // P1 controls no creature, so P1 is never prompted (CR 608.2d skip); only P2 answers.
    let waitingTrigger: EngineStackObject[] = [];
    pump(runPrioritySequence(ctx), (decision) => {
      const pass = decision.options.findIndex((entry) => entry.type === 'pass');
      if (pass < 0) return answer(decision, 0);
      if (waitingTrigger.length === 0) {
        waitingTrigger = ctx.state.stack.filter((entry) => entry.kind === 'triggeredAbility');
      }
      return { index: pass, targets: new Map() };
    });
    expect(ctx.state.stack).toHaveLength(0);

    expect(countersOn(watched)).toBe(2);
    expect(watched.counterTimestamps?.['+1/+1']).toBeGreaterThan(0);
    // The chooser's other eligible creature was not elected and stayed untouched.
    expect(countersOn(theirBear)).toBe(0);
    // Crossing the threshold queued the counter's own threshold trigger, exactly as a single
    // addCounters would: it was put on the stack as ONE waiting ability sourced by the
    // permanent, then resolved there and paid out its controller's 3 life.
    expect(waitingTrigger, 'Watching Bear life trigger waited on the stack').toHaveLength(1);
    expect(waitingTrigger[0]?.sourceId).toBe(watched.id);
    expect(playerById(ctx, 'P2').life).toBe(40 + 3);
  });
});
