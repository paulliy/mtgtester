/**
 * PR08.13: Agitator Ant (docs/plans/card-coverage-chunks.md).
 *
 * Both sentences of the card are one unmodeled interpreter line, one engine clause, and one
 * simultaneous batch: "each player may put two +1/+1 counters" is an APNAP choice set in which
 * every choice is collected before any counter moves (CR 608.2d), and "goad each creature that
 * had counters put on it this way" reads back exactly the placements that survived replacements.
 *
 * Production paths throughout: `beginEndStep` queues the trigger exactly as a real end step
 * does, the choices and counters resolve inside a real priority sequence, and the combat
 * assertions run a real combat phase. The one place the resolution is driven directly
 * (`executeAbility`) is the APNAP-order proof, which needs the ability's controller to differ
 * from the active player — a state a real game can hold but an end step of the controller's own
 * turn cannot.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import type { CardDefinition } from '../src/cards/definition';
import { computeCharacteristics } from '../src/effects/continuous';
import { interpretCard } from '../src/cards/interpret';
import { defineCard, fixtureOracleId } from '../src/cards/overrides';
import { runCombatPhase } from '../src/combat/combat';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { executeAbility } from '../src/effects/resolve';
import { addMana, drainPool } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { changeController, moveObject, playerById } from '../src/state/objects';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { beginEndStep, cleanupStep, runBeginningAndPrecombatMain } from '../src/turn/turn';
import {
  conjure,
  copies,
  declareAttacks,
  forest,
  gameConfig,
  oracle,
  pick,
  pump,
  spawn,
} from './fixtures';

const CARD_NAME = 'Agitator Ant';
const CARD_ID = 'abe377f8-35f0-4dea-a681-91d31a36815c';

/** The pinned Oracle text, with its reminder text (CR 207.2 — reminder text is not rules text). */
const PIN_TEXT =
  'At the beginning of your end step, each player may put two +1/+1 counters on a creature they ' +
  'control. Goad each creature that had counters put on it this way. (Until your next turn, those ' +
  'creatures attack each combat if able and attack a player other than you if able.)';

/** The interpreted line — the handler's reason minus its "unrecognized rules text" prefix. */
const HANDLED_LINE =
  'At the beginning of your end step, each player may put two +1/+1 counters on a creature they ' +
  'control. Goad each creature that had counters put on it this way.';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}
const pins = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/coverage-pr08-oracle.json'), 'utf8'),
  ) as PinnedFixture
).cards;
const antPin = pins.find((pin) => pin.card.name === CARD_NAME);
if (antPin === undefined) throw new Error('missing pinned Oracle fixture for Agitator Ant');

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

const passFirst = (decision: PendingDecision): DecisionOutcome => ({
  index: Math.max(
    0,
    decision.options.findIndex((option) => option.type === 'pass'),
  ),
  targets: new Map(),
});

function turnOfPlayer(ctx: GameContext, playerId: string): void {
  ctx.state.currentTurnPlayer = playerId;
  ctx.state.activePlayerIndex = Number(playerId.slice(1)) - 1;
}

function castOptionFor(ctx: GameContext, playerId: string, objectId: string) {
  return computePriorityOptions(ctx, playerById(ctx, playerId)).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === objectId;
  });
}

function takeAction(ctx: GameContext, playerId: string, payload: PriorityActionPayload) {
  return pump(
    applyPriorityAction(ctx, playerById(ctx, playerId), payload, {
      index: 0,
      targets: new Map(),
    }),
  );
}

/** Every player passes: waiting triggers go on the stack and resolve to completion. */
function settle(ctx: GameContext, answer?: Answer) {
  return pump(runPrioritySequence(ctx), (decision, count) => {
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    if (pass >= 0) return { index: pass, targets: new Map() };
    return answer?.(decision, count) ?? { index: 0, targets: new Map() };
  });
}

interface AntChoice {
  playerId: string;
  /** Creature name, or null to decline. */
  pick: string | null;
}

const sumpCard = (): OracleCard =>
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
function createCounterSump(): void {
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
  expect(interpretCard(printed).modeled).toBe(true);
}

/**
 * Answer the Ant's per-player `chooseCard` menus in the planned choice order. Every player who
 * controls at least one creature is asked in APNAP order — the callback asserts that scope (each
 * chooser's options name exactly that chooser's creatures), that the decline option is present
 * and last, that no raw card payload reaches the menu, and that no counter has moved yet while
 * any choice is still open (CR 608.2d).
 */
function antAnswers(ctx: GameContext, chosen: AntChoice[]): Answer {
  const planned = [...chosen];
  return (decision) => {
    expect(decision.decisionType).toBe('general');
    // In production the asking source is named as the whole stack entry ("Agitator Ant — <line>"),
    // so assert on the ask itself plus the card name prefix.
    expect(decision.prompt).toContain(
      'put 2 +1/+1 counters on a creature you control, or put none.',
    );
    expect(decision.prompt.startsWith(CARD_NAME)).toBe(true);
    expect(decision.options.at(-1)?.description).toBe('Put no counters');
    expect(
      decision.options.every(
        (option) => option.payload === undefined && option.targets === undefined,
      ),
      'no raw card payload on the choice menu',
    ).toBe(true);
    const plan = planned.shift();
    expect(plan?.playerId, `a menu for ${decision.player} was not planned`).toBe(decision.player);
    // Nothing has been placed yet: every choice is frozen before the first counter moves.
    for (const perm of ctx.state.battlefield) {
      expect(perm.counters['+1/+1'] ?? 0, perm.name).toBe(0);
      expect(perm.goadedBy, perm.name).toBeUndefined();
    }
    if (plan!.pick === null) {
      const decline = decision.options.findIndex(
        (option) => option.description === 'Put no counters',
      );
      return { index: decline, targets: new Map() };
    }
    // Only the chooser's OWN CREATURES are ever on the menu — not other permanents they control.
    const offered = decision.options
      .slice(0, decision.options.length - 1)
      .map((option) => option.description.replace('Put 2 +1/+1 counters on ', ''));
    for (const name of offered) {
      const offeredPerm = ctx.state.battlefield.find((perm) => perm.name === name);
      expect(offeredPerm?.controllerId, `${name} must belong to ${decision.player}`).toBe(
        decision.player,
      );
    }
    expect(offered, `${decision.player} may only pick creatures they control`).toEqual(
      ctx.state.battlefield
        .filter(
          (perm) =>
            perm.controllerId === decision.player &&
            computeCharacteristics(ctx, perm).types.includes('Creature'),
        )
        .map((perm) => perm.name),
    );
    const index = decision.options.findIndex(
      (option) => option.description === `Put 2 +1/+1 counters on ${plan!.pick}`,
    );
    expect(index, `a choice for ${plan!.pick}`).toBeGreaterThan(-1);
    return { index, targets: new Map() };
  };
}

const goaders = (perm: EnginePermanent): string[] =>
  (perm.goadedBy ?? []).map((entry) => entry.goaderId);

const countersOn = (perm: EnginePermanent): number => perm.counters['+1/+1'] ?? 0;

const countersLog = (ctx: GameContext) =>
  ctx.state.eventLog.filter((event) => event.type === 'counters');

const permanentChoices = (ctx: GameContext) =>
  ctx.state.eventLog.filter((event) => event.type === 'permanentChoice');

/** Queue the Ant's trigger through the real end step and resolve it through real priority. */
function runAntEndStep(ctx: GameContext, chosen: AntChoice[]): PendingDecision[] {
  beginEndStep(ctx);
  expect(ctx.state.pendingTriggers).toHaveLength(1);
  expect(ctx.state.pendingTriggers[0]?.controllerId).toBe(
    ctx.state.battlefield.find((perm) => perm.name === CARD_NAME)?.controllerId,
  );
  const answer = antAnswers(ctx, chosen);
  const answered: PendingDecision[] = [];
  pump(runPrioritySequence(ctx), (decision, count) => {
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    if (pass >= 0) return { index: pass, targets: new Map() };
    answered.push(decision);
    return answer(decision, count);
  });
  return answered;
}

describe('Agitator Ant (PR08.13)', () => {
  it('agitator-pinned-oracle-supported — both registrations author the single two-sentence trigger under the real id and the fixture alias', () => {
    expect(antPin.sha256).toBe('02655069d32bb3566e265f4d4ee06a65e89067c753c393dcb57eca89f7cbb53a');
    expect(antPin.card.oracleId).toBe(CARD_ID);
    expect(antPin.card.oracleText).toBe(PIN_TEXT);
    for (const card of [antPin.card, { ...antPin.card, oracleId: fixtureOracleId(CARD_NAME) }]) {
      const def = interpretCard(card);
      expect(def.unmodeledReasons, card.oracleId).toEqual([]);
      expect(def.modeled, card.oracleId).toBe(true);
      expect(def.triggers, card.oracleId).toHaveLength(1);
      expect(def.triggers[0]!).toMatchObject({
        kind: 'triggered',
        trigger: { when: 'endStep', player: 'you' },
        targets: [],
        effects: [
          {
            op: 'eachPlayerMayPutCountersAndGoad',
            counter: '+1/+1',
            count: { kind: 'const', n: 2 },
          },
        ],
      });
      expect(def.triggers[0]?.optional).toBeFalsy();
      // The trigger description is the handled reason verbatim: no "unrecognized rules text"
      // prefix and no reminder-text parenthetical (CR 207.2 — reminder text is not rules text).
      expect(def.triggers[0]?.description, card.oracleId).toBe(HANDLED_LINE);
    }
  });

  it('agitator-pinned-def-is-clean — the authored definition carries the printed card statistics and passes authoring validation', () => {
    const def = interpretCard(antPin.card);
    expect(def.name).toBe(CARD_NAME);
    expect(def.types).toEqual(['Creature']);
    expect(def.subtypes).toEqual(['Insect']);
    expect(def.manaCost).toMatchObject({ generic: 2, colored: { R: 1 } });
    expect([def.power, def.toughness]).toEqual([2, 2]);
    expect(def.spellAbility).toBeNull();
    expect(def.activatedAbilities).toEqual([]);
    expect(def.staticEffects).toEqual([]);
    expect(validateCardDefinition(def)).toEqual([]);
  });

  it('agitator-normal-cast-pays-two-generic-and-one-red-and-enters-unremarkable — printed payment precedes resolution, and the 2/2 enters with neither counters nor goad', () => {
    const ctx = pod('agitator-cast');
    const caster = playerById(ctx, 'P1');
    const card = conjure(ctx, 'P1', antPin.card, 'hand');
    addMana(caster, [{ symbol: 'C' }, { symbol: 'C' }, { symbol: 'R' }]);

    const option = castOptionFor(ctx, 'P1', card.id);
    expect(option, '{2}{R} is castable from hand in a main phase').toBeDefined();
    expect(option!.targets ?? []).toHaveLength(0);
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(ctx.state.stack).toHaveLength(1);
    expect(caster.manaEntries).toHaveLength(0);

    settle(ctx);
    expect(ctx.state.stack).toHaveLength(0);
    const ant = ctx.state.battlefield.find((entry) => entry.cardId === card.cardId);
    expect(ant).toBeDefined();
    expect(ant!.controllerId).toBe('P1');
    expect(ant!.ownerId).toBe('P1');
    expect(ant!.summoningSick).toBe(true);
    expect(ant!.isToken).toBe(false);
    expect(
      ctx.state.eventLog.some(
        (event) => event.type === 'castSpell' && event.payload['name'] === CARD_NAME,
      ),
    ).toBe(true);
    expect(countersOn(ant!)).toBe(0);
    expect(ant!.goadedBy).toBeUndefined();
    expect(countersLog(ctx)).toEqual([]);
  });

  it('agitator-normal-cast-rejects-insufficient-mana-and-nonmain-timing — the colored pip, the generic total, and sorcery timing all gate the cast', () => {
    const ctx = pod('agitator-cast-illegal');
    const player = playerById(ctx, 'P1');
    const card = conjure(ctx, 'P1', antPin.card, 'hand');

    // Two generic without the red pip: {2}{R} cannot be paid without the red symbol.
    addMana(player, [{ symbol: 'C' }, { symbol: 'C' }]);
    expect(castOptionFor(ctx, 'P1', card.id)).toBeUndefined();

    // A red pip alone is a real total shortfall for {2}{R}.
    drainPool(player, true);
    addMana(player, [{ symbol: 'R' }]);
    expect(castOptionFor(ctx, 'P1', card.id)).toBeUndefined();

    // One generic plus the red pip is still one short.
    drainPool(player, true);
    addMana(player, [{ symbol: 'C' }, { symbol: 'R' }]);
    expect(castOptionFor(ctx, 'P1', card.id)).toBeUndefined();

    addMana(player, [{ symbol: 'C' }]);
    expect(castOptionFor(ctx, 'P1', card.id)).toBeDefined();

    // A creature is cast on main phases only.
    ctx.state.phase = 'combat';
    ctx.state.step = 'declareBlockers';
    expect(castOptionFor(ctx, 'P1', card.id)).toBeUndefined();
    ctx.state.phase = 'precombatMain';
    ctx.state.step = null;
    expect(castOptionFor(ctx, 'P1', card.id)).toBeDefined();
  });

  it('agitator-end-step-is-your-end-step-only — the Ant triggers on its controller end step, and may pick itself; another player end step does not trigger', () => {
    const ctx = pod('agitator-end-steps');
    const ant = spawn(ctx, 'P1', antPin.card);

    beginEndStep(ctx);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    expect(ctx.state.pendingTriggers[0]?.controllerId).toBe('P1');
    const { decisions } = settle(ctx, antAnswers(ctx, [{ playerId: 'P1', pick: CARD_NAME }]));
    // P1 controls exactly one creature — the Ant itself — and is the only player asked: P2, P3
    // and P4 control no creature at all, so they are never prompted.
    expect(decisions.map((decision) => decision.player)).toEqual(['P1']);
    expect(countersOn(ant)).toBe(2);
    expect(ant.counterTimestamps?.['+1/+1']).toBeGreaterThan(0);
    expect(goaders(ant)).toEqual(['P1']);

    // P2's end step is not "your end step" for an Ant controlled by P1.
    turnOfPlayer(ctx, 'P2');
    beginEndStep(ctx);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    settle(ctx);
  });

  it('agitator-apnap-active-first-choices-frozen-before-counters — an Ant of a NON-active controller (P1) while P3 is active asks P3, P4, P1, P2 in the ACTIVE player order; choices are public; no counter moves until every choice exists', () => {
    const ctx = pod('agitator-apnap');
    const ant = spawn(ctx, 'P1', antPin.card);
    const p3Courier = spawn(
      ctx,
      'P3',
      oracle({ name: 'P3 Courier', typeLine: 'Creature — Scout' }),
    );
    const p4Marauder = spawn(
      ctx,
      'P4',
      oracle({ name: 'P4 Marauder', typeLine: 'Creature — Raider' }),
    );
    const p1Alpha = spawn(ctx, 'P1', oracle({ name: 'P1 Alpha', typeLine: 'Creature — Dog' }));
    const p1Beta = spawn(ctx, 'P1', oracle({ name: 'P1 Beta', typeLine: 'Creature — Dog' }));
    const p2Flanker = spawn(ctx, 'P2', oracle({ name: 'P2 Flanker', typeLine: 'Creature — Fox' }));

    // The ability's controller stays P1 while the ACTIVE player is P3 — the choice order is
    // APNAP from the active player P3 (CR 101.4), never "Ant controller first".
    turnOfPlayer(ctx, 'P3');
    const source = {
      id: ant.id,
      cardId: ant.cardId,
      oracleId: ant.oracleId,
      name: ant.name,
      controllerId: 'P1',
    };
    const ability = interpretCard(antPin.card).triggers[0]!;

    const earlierPicks: string[][] = [];
    const { decisions } = pump(executeAbility(ctx, source, ability, []), (decision, count) => {
      expect(decision.decisionType).toBe('general');
      expect(decision.prompt).toContain(
        'put 2 +1/+1 counters on a creature you control, or put none.',
      );
      expect(decision.options.at(-1)?.description).toBe('Put no counters');
      expect(
        decision.options.every(
          (option) => option.payload === undefined && option.targets === undefined,
        ),
        'no raw card payload on the choice menu',
      ).toBe(true);
      // While ANY choice is open, no counter has moved and no goad exists (CR 608.2d).
      for (const perm of ctx.state.battlefield) {
        expect(perm.counters['+1/+1'] ?? 0, perm.name).toBe(0);
        expect(perm.goadedBy, perm.name).toBeUndefined();
      }
      // The choices made so far are public to the deciding player (druidPurification precedent).
      earlierPicks.push(
        ctx.state.eventLog
          .filter((event) => event.type === 'permanentChoice' && event.payload['name'] !== null)
          .map((event) => String(event.payload['name'])),
      );
      switch (count) {
        case 1: {
          // P3 declines: the decline is the LAST option, and the choice is published as none.
          expect(decision.player).toBe('P3');
          return { index: decision.options.length - 1, targets: new Map() };
        }
        case 2: {
          // P4 (a later seated player, but EARLIER in APNAP than P1/P2) picks its creature.
          expect(decision.player).toBe('P4');
          const index = decision.options.findIndex(
            (option) => option.description === `Put 2 +1/+1 counters on ${p4Marauder.name}`,
          );
          expect(index, 'a choice for P4 Marauder').toBeGreaterThan(-1);
          return { index, targets: new Map() };
        }
        case 3: {
          // P1 controls THREE creatures — the Ant itself plus two bears — and is offered exactly
          // those three plus the decline option: "a creature they control" reaches only the
          // chooser's own permanents.
          expect(decision.player).toBe('P1');
          expect(decision.options.slice(0, -1).map((option) => option.description)).toEqual([
            `Put 2 +1/+1 counters on ${CARD_NAME}`,
            `Put 2 +1/+1 counters on ${p1Alpha.name}`,
            `Put 2 +1/+1 counters on ${p1Beta.name}`,
          ]);
          const index = decision.options.findIndex(
            (option) => option.description === `Put 2 +1/+1 counters on ${p1Alpha.name}`,
          );
          expect(index, 'a choice for P1 Alpha').toBeGreaterThan(-1);
          return { index, targets: new Map() };
        }
        default: {
          expect(decision.player, 'the LAST menu belongs to P2').toBe('P2');
          // P2 controls one creature; the LAST chooser takes it (a real placement, not a decline).
          expect(decision.options.slice(0, -1).map((option) => option.description)).toEqual([
            `Put 2 +1/+1 counters on ${p2Flanker.name}`,
          ]);
          return { index: 0, targets: new Map() };
        }
      }
    });

    expect(decisions.map((decision) => decision.player)).toEqual(['P3', 'P4', 'P1', 'P2']);
    // The public log inside every menu shows only picks made before it: the first menus saw
    // nothing; P1's menu saw P4's pick (P3 declined), and P2's menu saw both.
    expect(earlierPicks).toEqual([[], [], [p4Marauder.name], [p4Marauder.name, p1Alpha.name]]);

    // Every surviving placement only happened after the last menu closed.
    expect(countersOn(p4Marauder)).toBe(2);
    expect(countersOn(p1Alpha)).toBe(2);
    expect(countersOn(p2Flanker)).toBe(2);
    expect(countersOn(p3Courier), 'P3 declined').toBe(0);
    expect(countersOn(p1Beta), 'P1 Beta was never picked').toBe(0);
    // The goad is bound by the ability's CONTROLLER (the Ant's caster P1), never by the chooser.
    expect(goaders(p4Marauder)).toEqual(['P1']);
    expect(goaders(p1Alpha)).toEqual(['P1']);
    expect(goaders(p2Flanker)).toEqual(['P1']);
    expect(p3Courier.goadedBy).toBeUndefined();
    expect(p1Beta.goadedBy).toBeUndefined();

    // One 'counters' record per actual placement, two added each, and P3's decline produced no
    // record at all.
    expect(countersLog(ctx).map((event) => event.payload['target'])).toEqual([
      p4Marauder.name,
      p1Alpha.name,
      p2Flanker.name,
    ]);
    expect(
      countersLog(ctx).every(
        (event) => event.payload['added'] === 2 && event.payload['total'] === 2,
      ),
    ).toBe(true);
    // The choices are public as they are made, with the chooser as the actor (APNAP order).
    expect(permanentChoices(ctx).map((event) => event.actorSeat)).toEqual(['P3', 'P4', 'P1', 'P2']);
    expect(permanentChoices(ctx).map((event) => event.payload['name'] ?? null)).toEqual([
      null,
      p4Marauder.name,
      p1Alpha.name,
      p2Flanker.name,
    ]);
  });

  it('agitator-empty-players-not-asked-and-decline-puts-nothing — players with no creature are never prompted, and a decline publishes nothing placed', () => {
    const ctx = pod('agitator-skips');
    spawn(ctx, 'P1', antPin.card);
    const bear = spawn(ctx, 'P2', oracle({ name: 'P2 Hiker', typeLine: 'Creature — Bear' }));

    beginEndStep(ctx);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    const expectedChoosers = ['P1', 'P2'];
    const { decisions } = pump(runPrioritySequence(ctx), (decision) => {
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      if (pass >= 0) return { index: pass, targets: new Map() };
      // P1 (through the Ant itself) and P2 (through the Bear) control creatures; P3 and P4
      // control none and are not asked at all.
      expect(expectedChoosers.shift(), `chooser order: ${decision.player}`).toBe(decision.player);
      return { index: decision.options.length - 1, targets: new Map() };
    });
    expect(decisions.map((decision) => decision.player)).toEqual(['P1', 'P2']);
    expect(expectedChoosers).toEqual([]);
    expect(countersLog(ctx)).toEqual([]);
    expect(bear.goadedBy).toBeUndefined();
    // Each declined choice is still published, with no object: the decline is public (druid
    // precedent), and P3/P4 never appear at all.
    expect(permanentChoices(ctx).map((event) => event.actorSeat)).toEqual(['P1', 'P2']);
    expect(
      permanentChoices(ctx).every(
        (event) => event.payload['name'] === null && event.payload['objectId'] === null,
      ),
    ).toBe(true);
  });

  it('agitator-doubling-season-replacement — a controller-wide doubling replacement grows the plan to four, planned over the PRE-placement state, without losing the goad', () => {
    const ctx = pod('agitator-doubling');
    spawn(ctx, 'P1', antPin.card);
    // The real card's interpreter output is the generic counterPlacementReplacement the batch
    // consults: ONE replacement pass from the pre-placement state, not a per-placement loop.
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
    const mine = spawn(ctx, 'P1', oracle({ name: 'P1 Growth Bear', typeLine: 'Creature — Bear' }));
    const yours = spawn(ctx, 'P2', oracle({ name: 'P2 Bear', typeLine: 'Creature — Bear' }));

    runAntEndStep(ctx, [
      { playerId: 'P1', pick: mine.name },
      { playerId: 'P2', pick: yours.name },
    ]);

    expect(countersOn(mine)).toBe(4);
    expect(mine.counterTimestamps?.['+1/+1']).toBeGreaterThan(0);
    expect(goaders(mine)).toEqual(['P1']);
    // The replacement static belongs to P1: P2's placement is unmodified.
    expect(countersOn(yours)).toBe(2);
    expect(yours.counterTimestamps?.['+1/+1']).toBeGreaterThan(0);
    expect(goaders(yours)).toEqual(['P1']);
  });

  it('agitator-replacement-to-zero-logs-the-zero-and-never-goads — a placement fully replaced to zero is logged with its 0 but is not a creature that "had counters put on it this way"', () => {
    const ctx = pod('agitator-zero');
    spawn(ctx, 'P1', antPin.card);
    // A carrier that zeroes +1/+1 counters put on permanents ITS controller controls.
    createCounterSump();
    spawn(ctx, 'P2', sumpCard());
    const mine = spawn(ctx, 'P1', oracle({ name: 'P1 Bear', typeLine: 'Creature — Bear' }));
    const yours = spawn(ctx, 'P2', oracle({ name: 'P2 Bear', typeLine: 'Creature — Bear' }));

    runAntEndStep(ctx, [
      { playerId: 'P1', pick: mine.name },
      { playerId: 'P2', pick: yours.name },
    ]);

    expect(countersOn(mine)).toBe(2);
    expect(goaders(mine)).toEqual(['P1']);
    // P2's counters were replaced to zero: nothing was put on it, so the goad clause — which
    // reads back the creatures that ACTUALLY received counters this batch — names nothing there.
    expect(countersOn(yours)).toBe(0);
    expect(yours.counters).not.toHaveProperty('+1/+1');
    expect(yours.counterTimestamps?.['+1/+1']).toBeUndefined();
    expect(goaders(yours)).toEqual([]);
    // The zero placement was still published, honestly, as a 0.
    const log = countersLog(ctx).filter((event) => event.payload['target'] === yours.name);
    expect(log).toHaveLength(1);
    expect(log[0]?.payload['added']).toBe(0);
    expect(log[0]?.payload['total']).toBe(0);
  });

  it('agitator-queued-trigger-outlives-its-source-and-keeps-its-controller — a pending trigger resolves as the controller it was queued for, no matter who later holds the gone card', () => {
    const ctx = pod('agitator-source-gone');
    const ant = spawn(ctx, 'P1', antPin.card);
    const mine = spawn(ctx, 'P1', oracle({ name: 'P1 Bear', typeLine: 'Creature — Bear' }));
    const yours = spawn(ctx, 'P2', oracle({ name: 'P2 Bear', typeLine: 'Creature — Bear' }));

    beginEndStep(ctx);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    const queuedController = ctx.state.pendingTriggers[0]?.controllerId;
    expect(queuedController).toBe('P1');
    // Whoever controls the permanent now cannot re-scope a queued ability, and the resolution
    // continues even after the source has left the battlefield entirely (CR 608.2h).
    changeController(ctx, ant, 'P4', { kind: 'untilEndOfTurn' });
    pump(moveObject(ctx, ant, { zone: 'hand' }));
    expect(ctx.state.battlefield.some((perm) => perm.id === ant.id)).toBe(false);

    settle(
      ctx,
      antAnswers(ctx, [
        { playerId: 'P1', pick: mine.name },
        { playerId: 'P2', pick: yours.name },
      ]),
    );
    expect(queuedController).toBe('P1');
    expect(countersOn(mine)).toBe(2);
    expect(countersOn(yours)).toBe(2);
    // The goader is the ORIGINAL controller P1 — captured when the trigger was queued — not the
    // departed card's last controller P4.
    expect(goaders(mine)).toEqual(['P1']);
    expect(goaders(yours)).toEqual(['P1']);
  });

  it('agitator-goaded-creature-must-attack-and-spare-its-goader — a P2 creature goaded by P1 during a real end step must attack a player other than P1', () => {
    const ctx = pod('agitator-combat');
    spawn(ctx, 'P1', antPin.card);
    const bear = spawn(ctx, 'P2', oracle({ name: 'P2 Bear', typeLine: 'Creature — Bear' }));

    runAntEndStep(ctx, [
      { playerId: 'P1', pick: CARD_NAME },
      { playerId: 'P2', pick: bear.name },
    ]);
    expect(goaders(bear)).toEqual(['P1']);

    // The goaded creature's controller must be the active player when combat is declared.
    turnOfPlayer(ctx, 'P2');
    ctx.state.turnNumber += 1;
    ctx.state.phase = 'combat';
    ctx.state.step = null;
    pump(runCombatPhase(ctx), (decision) => {
      if (decision.decisionType === 'declareAttackers' && decision.player === 'P2') {
        const subject = decision.presentationAttackDeclaration?.subjects.find(
          (entry) => entry.name === bear.name,
        );
        expect(subject?.mustAttack, 'the goad forces the attack').toBe(true);
        expect(
          subject?.defenders.map((defender) => defender.playerId),
          'the goader is not a legal defender',
        ).not.toContain('P1');
        return declareAttacks(decision, (_subjectId, entry) =>
          entry.name === bear.name ? 'P3' : null,
        );
      }
      return pick(decision, /Pass|does not/);
    });
    const attack = ctx.state.eventLog.find(
      (event) => event.type === 'attack' && event.payload['attacker'] === bear.name,
    );
    expect(attack?.payload['defender']).toBe('P3');
  });

  it('agitator-goad-expires-at-the-goaders-next-turn-not-cleanup — the cleanup step and other seats turns leave it, and P1 untap strips it', () => {
    const ctx = pod('agitator-expiry');
    spawn(ctx, 'P1', antPin.card);
    const bear = spawn(ctx, 'P2', oracle({ name: 'P2 Bear', typeLine: 'Creature — Bear' }));
    const appliedTurn = ctx.state.turnNumber;

    runAntEndStep(ctx, [
      { playerId: 'P1', pick: null },
      { playerId: 'P2', pick: bear.name },
    ]);
    expect(bear.goadedBy).toEqual([{ goaderId: 'P1', appliedTurn }]);

    // The cleanup step ends every "until end of turn" effect; the goad is NOT one of them.
    pump(cleanupStep(ctx));
    expect(goaders(bear)).toEqual(['P1']);

    // A different player turn also leaves the goad alone: only the goader NEXT turn ends it.
    turnOfPlayer(ctx, 'P4');
    ctx.state.turnNumber += 1;
    pump(runBeginningAndPrecombatMain(ctx), passFirst);
    expect(goaders(bear)).toEqual(['P1']);

    // P1 next turn begins: the untap step (CR 701.15d, via the existing goad store) strips it.
    turnOfPlayer(ctx, 'P1');
    ctx.state.turnNumber += 3;
    pump(runBeginningAndPrecombatMain(ctx), passFirst);
    expect(bear.goadedBy).toBeUndefined();
  });

  it('agitator-removing-counters-keeps-the-goad — the goad clause fired when the counters were put; losing them later is not its business', () => {
    const ctx = pod('agitator-remove');
    spawn(ctx, 'P1', antPin.card);
    const bear = spawn(ctx, 'P2', oracle({ name: 'P2 Bear', typeLine: 'Creature — Bear' }));
    runAntEndStep(ctx, [
      { playerId: 'P1', pick: null },
      { playerId: 'P2', pick: bear.name },
    ]);
    expect(bear.counters['+1/+1']).toBe(2);
    expect(goaders(bear)).toEqual(['P1']);

    // A real {0} instant removes the counters through the ordinary cast path.
    const wipeCard = oracle({
      name: 'Counter Wipe',
      typeLine: 'Instant',
      manaCost: '{0}',
      oracleText: 'Remove four +1/+1 counters from target creature.',
    });
    expect(interpretCard(wipeCard).modeled).toBe(true);
    const wiped = conjure(ctx, 'P2', wipeCard, 'hand');
    const option = castOptionFor(ctx, 'P2', wiped.id);
    expect(option, 'a {0} instant is castable during an end step').toBeDefined();
    pump(
      applyPriorityAction(ctx, playerById(ctx, 'P2'), option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, bear.id]]),
      }),
    );
    settle(ctx);
    expect(ctx.state.stack).toHaveLength(0);
    expect(bear.counters['+1/+1'] ?? 0).toBe(0);
    // Removing the counters later does not remove the goad — the goad condition ("had counters
    // put on it this way") was evaluated once, at the batch.
    expect(goaders(bear)).toEqual(['P1']);
  });

  it('agitator-blink-new-incarnation — a blinked creature is a new object: no counters, and no goad requirement carried across', () => {
    const ctx = pod('agitator-blink');
    spawn(ctx, 'P1', antPin.card);
    const bear = spawn(ctx, 'P2', oracle({ name: 'P2 Bear', typeLine: 'Creature — Bear' }));
    runAntEndStep(ctx, [
      { playerId: 'P1', pick: null },
      { playerId: 'P2', pick: bear.name },
    ]);
    expect(countersOn(bear)).toBe(2);
    expect(goaders(bear)).toEqual(['P1']);

    // The blink is two real zone changes: out to exile, then back onto the battlefield, each
    // through the ordinary move path — so the return is a NEW object (CR 400.7).
    pump(moveObject(ctx, bear, { zone: 'exile' }));
    expect(ctx.state.battlefield.some((perm) => perm.id === bear.id)).toBe(false);
    const inExile = ctx.state.exile.find((entry) => entry.cardId === bear.cardId);
    expect(inExile).toBeDefined();
    pump(moveObject(ctx, inExile!, { zone: 'battlefield' }));
    const returned = ctx.state.battlefield.find((perm) => perm.cardId === bear.cardId);
    expect(returned).toBeDefined();
    expect(returned!.id).not.toBe(bear.id);
    expect(countersOn(returned!)).toBe(0);
    // The goad requirement lived on the OLD object; the new incarnation carries none.
    expect(returned!.goadedBy).toBeUndefined();
  });
});
