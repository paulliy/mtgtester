/**
 * PR08.16 card coverage: Kazuul, Tyrant of the Cliffs
 * (docs/plans/card-coverage-chunks.md — control changes and multiplayer choices).
 *
 * A genuine intervening-if over the trigger's exact original attacker, an event-object payer,
 * and real {3}{R}{R} casting. The condition/payer primitives' own runtime contracts live in
 * `defending-player-event-contract.test.ts` and `event-object-payer-contract.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { candidateOf, computeCharacteristics } from '../src/effects/continuous';
import { selectMatches } from '../src/cards/selector';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import {
  changeController,
  moveObject,
  playerById,
  queueTriggersForEvent,
  removeFromCombat,
} from '../src/state/objects';
import { runCombatPhase } from '../src/combat/combat';
import { runPrioritySequence } from '../src/turn/priority';
import { resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { addMana } from '../src/mana/pool';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import {
  conjure,
  copies,
  declareAttacks,
  forest,
  gameConfig,
  oracle,
  pump,
  spawn,
  swamp,
} from './fixtures';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}
const pins = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/coverage-pr08-oracle.json'), 'utf8'),
  ) as PinnedFixture
).cards;
const kazuulPin = pins.find((pin) => pin.card.name === 'Kazuul, Tyrant of the Cliffs');
if (kazuulPin === undefined) throw new Error('missing pinned Oracle fixture for Kazuul');

/** A generic attacking creature; its controller is who Kazuul asks to pay (CR 608.2h). */
const witnessCard = (): OracleCard =>
  oracle({
    name: 'Cliff Witness',
    typeLine: 'Creature — Beast',
    power: '2',
    toughness: '2',
  });

/** A generic kill spell: "Destroy target creature." with a one-symbol cost P1 can hold. */
const verdictCard = (): OracleCard =>
  oracle({
    name: 'Lab Verdict',
    typeLine: 'Instant',
    manaCost: '{B}',
    oracleText: 'Destroy target creature.',
  });

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

function combatPod(ctx: GameContext, attacker: string): void {
  ctx.state.currentTurnPlayer = attacker;
  ctx.state.activePlayerIndex = Number(attacker.slice(1)) - 1;
  ctx.state.phase = 'combat';
  ctx.state.step = null;
}

function passOutcome(decision: PendingDecision): DecisionOutcome {
  // Kazuul's trigger is mandatory ("unless that creature's controller pays"): no "use it?" first.
  expect(decision.decisionType).not.toBe('optionalTrigger');
  return {
    index: Math.max(
      0,
      decision.options.findIndex((option) => option.type === 'pass'),
    ),
    targets: new Map(),
  };
}

const isPayPrompt = (decision: PendingDecision): boolean =>
  decision.decisionType === 'general' && decision.prompt.includes('pay {3}');

function payChoice(decision: PendingDecision, want: 'pay' | 'decline'): DecisionOutcome {
  const text = want === 'pay' ? 'Pay {3}' : "Don't pay {3}";
  const index = decision.options.findIndex((option) => option.description === text);
  if (index < 0)
    throw new Error(
      `no option ${text} in ${decision.options.map((o) => o.description).join(' | ')}`,
    );
  return { index, targets: new Map() };
}

function priorityOptions(ctx: GameContext, playerId: string) {
  return computePriorityOptions(ctx, playerById(ctx, playerId));
}

function castOptionFor(ctx: GameContext, playerId: string, objectId: string) {
  return priorityOptions(ctx, playerId).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === objectId;
  });
}

type Answer = (decision: PendingDecision, count: number) => DecisionOutcome;

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

const events = (ctx: GameContext, type: string) =>
  ctx.state.eventLog.filter((event) => event.type === type);

function ogers(ctx: GameContext, controllerId: string): EnginePermanent[] {
  return ctx.state.battlefield.filter(
    (p) => p.isToken && p.name === 'Ogre' && p.controllerId === controllerId,
  );
}

function manaTotal(ctx: GameContext, playerId: string): number {
  return Object.values(playerById(ctx, playerId).manaPool).reduce(
    (sum, value) => sum + (value ?? 0),
    0,
  );
}

describe('Kazuul, Tyrant of the Cliffs', () => {
  it('kazuul-pinned-oracle-supported — kazuul pinned oracle supported', () => {
    expect(kazuulPin.sha256).toBe(
      '5abee12570a0c0eb3f59f49417651ea5416ef70a985d592cf714d5457c008c0c',
    );
    expect(kazuulPin.card.oracleText).toBe(
      "Whenever a creature an opponent controls attacks, if you're the defending player, create a 3/3 red Ogre creature token unless that creature's controller pays {3}.",
    );
    for (const card of [
      kazuulPin.card,
      { ...kazuulPin.card, oracleId: fixtureOracleId('Kazuul, Tyrant of the Cliffs') },
    ]) {
      const def = interpretCard(card);
      expect(def.unmodeledReasons, card.oracleId).toEqual([]);
      expect(def.modeled, card.oracleId).toBe(true);
      const [triggeredAbility] = def.triggers;
      const trigger = triggeredAbility?.trigger;
      expect(trigger?.when).toBe('attacks');
      if (trigger === undefined || !('subject' in trigger))
        throw new Error('Kazuul trigger has no permanent subject');
      expect(trigger.subject.kind).toBe('permanent');
      expect(trigger.condition).toEqual({
        kind: 'eventObjectDefendingPlayerIsYou',
      });
      const [effect] = triggeredAbility?.effects ?? [];
      expect(effect).toMatchObject({
        op: 'unlessPays',
        payer: 'eventObjectController',
        cost: { generic: 3, colored: {}, colorless: 0 },
        then: [
          {
            op: 'createToken',
            spec: {
              name: 'Ogre',
              subtypes: ['Ogre'],
              colors: ['R'],
              power: 3,
              toughness: 3,
            },
          },
        ],
      });
      expect(validateCardDefinition(def)).toEqual([]);
    }
  });

  it('kazuul-normal-cast-pays-three-generic-two-red-and-resolves — normal cast resolves', () => {
    const ctx = pod('kazuul-cast');
    const card = conjure(ctx, 'P1', kazuulPin.card, 'hand');
    addMana(playerById(ctx, 'P1'), [
      { symbol: 'C' },
      { symbol: 'C' },
      { symbol: 'C' },
      { symbol: 'R' },
      { symbol: 'R' },
    ]);
    const option = castOptionFor(ctx, 'P1', card.id);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(ctx.state.stack).toHaveLength(1);
    expect(manaTotal(ctx, 'P1')).toBe(0);
    resolveTop(ctx);
    const permanent = ctx.state.battlefield.find((entry) => entry.cardId === card.cardId);
    expect(permanent).toBeDefined();
    expect(permanent!.summoningSick).toBe(true);
    expect(
      events(ctx, 'castSpell').some(
        (event) => event.payload['name'] === 'Kazuul, Tyrant of the Cliffs',
      ),
    ).toBe(true);
  });

  it('kazuul-normal-cast-unavailable-without-double-red — normal cast unavailable without double red', () => {
    const ctx = pod('kazuul-no-red');
    const card = conjure(ctx, 'P1', kazuulPin.card, 'hand');
    addMana(playerById(ctx, 'P1'), [
      { symbol: 'C' },
      { symbol: 'C' },
      { symbol: 'C' },
      { symbol: 'C' },
      { symbol: 'R' },
    ]);
    expect(castOptionFor(ctx, 'P1', card.id)).toBeUndefined();
  });

  it('kazuul-two-attackers-two-triggers-pay-one-decline-one-before-blocks — pay one decline one produces one token before blocks', () => {
    const ctx = pod('kazuul-two-attackers');
    spawn(ctx, 'P1', kazuulPin.card);
    const first = spawn(ctx, 'P2', witnessCard());
    const second = spawn(ctx, 'P2', witnessCard());
    // Real mana sources (CR 500.4 empties floating mana as the begin-combat step ends; tapping
    // lands has to come from the battlefield, exactly as in a live game).
    for (let i = 0; i < 6; i++) spawn(ctx, 'P2', forest());
    combatPod(ctx, 'P2');
    const payAnswers: Array<'pay' | 'decline'> = ['decline', 'pay'];
    const payCount = { n: 0 };
    let tokensAtBlocks: number | null = null;
    pump(runCombatPhase(ctx), (decision) => {
      if (decision.decisionType === 'declareAttackers')
        return declareAttacks(decision, (id) =>
          id === first.id || id === second.id ? 'P1' : null,
        );
      if (isPayPrompt(decision)) {
        payCount.n += 1;
        const want = payAnswers.shift();
        if (want === undefined) throw new Error('more pay prompts than answers expected');
        return payChoice(decision, want);
      }
      if (decision.decisionType === 'declareBlockers' && tokensAtBlocks === null)
        tokensAtBlocks = ogers(ctx, 'P1').length;
      return passOutcome(decision);
    });
    // Exactly one trigger per attacking creature, and both were asked to pay.
    expect(payAnswers).toHaveLength(0);
    expect(payCount.n).toBe(2);
    // Only the declined attack confirms its token; the paying attack was suppressed, paying via
    // tapped lands (no floating mana survives a step).
    expect(ogers(ctx, 'P1')).toHaveLength(1);
    const tappedForests = ctx.state.battlefield.filter(
      (p) => p.tapped && p.name === 'Forest',
    ).length;
    expect(tappedForests).toBe(3);
    expect(manaTotal(ctx, 'P2')).toBe(0);
    // The token existed by the time blockers could block (CR 508.5 order).
    expect(tokensAtBlocks).toBe(1);
  });

  it('kazuul-normal-cast-timing-and-total-mana — printed creature timing and full cost', () => {
    const ctx = pod('kazuul-timing-and-cost');
    const card = conjure(ctx, 'P1', kazuulPin.card, 'hand');
    addMana(playerById(ctx, 'P1'), [
      { symbol: 'C' },
      { symbol: 'C' },
      { symbol: 'R' },
      { symbol: 'R' },
    ]);
    expect(castOptionFor(ctx, 'P1', card.id)).toBeUndefined();
    addMana(playerById(ctx, 'P1'), [{ symbol: 'C' }]);
    expect(castOptionFor(ctx, 'P1', card.id)).toBeDefined();
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    expect(castOptionFor(ctx, 'P1', card.id)).toBeUndefined();
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    ctx.state.phase = 'combat';
    ctx.state.step = 'beginCombat';
    expect(castOptionFor(ctx, 'P1', card.id)).toBeUndefined();
  });

  it('kazuul-single-attacker-pays-and-no-token — single attacker pays, no token', () => {
    const ctx = pod('kazuul-single-pay');
    spawn(ctx, 'P1', kazuulPin.card);
    const witness = spawn(ctx, 'P2', witnessCard());
    // Real mana sources stand in for floating mana (CR 500.4 would drain the pool at the end
    // of the begin-combat step); the payment taps the lands at resolution.
    for (let i = 0; i < 3; i++) spawn(ctx, 'P2', forest());
    combatPod(ctx, 'P2');
    const payCount = { n: 0 };
    pump(runCombatPhase(ctx), (decision) => {
      if (decision.decisionType === 'declareAttackers')
        return declareAttacks(decision, (id) => (id === witness.id ? 'P1' : null));
      if (isPayPrompt(decision)) {
        payCount.n += 1;
        return payChoice(decision, 'pay');
      }
      return passOutcome(decision);
    });
    expect(payCount.n).toBe(1);
    expect(ogers(ctx, 'P1')).toHaveLength(0);
    expect(ctx.state.battlefield.filter((p) => p.tapped && p.name === 'Forest')).toHaveLength(3);
    expect(manaTotal(ctx, 'P2')).toBe(0);
    const paid = events(ctx, 'unlessPaid');
    expect(paid).toHaveLength(1);
    expect((paid[0]!.payload as { player: string }).player).toBe('P2');
  });

  it('kazuul-attack-on-another-player-triggers-nothing — attack on another player triggers nothing', () => {
    const ctx = pod('kazuul-other-defender');
    spawn(ctx, 'P1', kazuulPin.card);
    const witness = spawn(ctx, 'P2', witnessCard());
    combatPod(ctx, 'P2');
    const payCount = { n: 0 };
    pump(runCombatPhase(ctx), (decision) => {
      if (decision.decisionType === 'declareAttackers')
        return declareAttacks(decision, (id) => (id === witness.id ? 'P3' : null));
      if (isPayPrompt(decision)) payCount.n += 1;
      return passOutcome(decision);
    });
    expect(payCount.n).toBe(0);
    expect(ogers(ctx, 'P1')).toHaveLength(0);
    expect(events(ctx, 'unlessNotPaid')).toHaveLength(0);
  });

  it('kazuul-only-defending-players-copy-triggers — only the defending player copy triggers', () => {
    const ctx = pod('kazuul-two-copies');
    spawn(ctx, 'P1', kazuulPin.card);
    spawn(ctx, 'P3', kazuulPin.card);
    const witness = spawn(ctx, 'P2', witnessCard());
    // P2 must be ABLE to pay so the decline is a real choice (unable ⇒ no prompt at all).
    for (let i = 0; i < 3; i++) spawn(ctx, 'P2', forest());
    combatPod(ctx, 'P2');
    const payCount = { n: 0 };
    let asked: string | null = null;
    pump(runCombatPhase(ctx), (decision) => {
      if (decision.decisionType === 'declareAttackers')
        return declareAttacks(decision, (id) => (id === witness.id ? 'P1' : null));
      if (isPayPrompt(decision)) {
        payCount.n += 1;
        asked = decision.player;
        return payChoice(decision, 'decline');
      }
      return passOutcome(decision);
    });
    // Both copies see the same event; only P1's Kazuul is the defending player, so exactly one
    // pay prompt was surfaced (to P2, the event creature's controller) and one token appeared.
    expect(payCount.n).toBe(1);
    expect(asked).toBe('P2');
    // Declining tapped nothing: the alternative cost was never paid.
    expect(ctx.state.battlefield.filter((p) => p.tapped && p.name === 'Forest')).toHaveLength(0);
    expect(ogers(ctx, 'P1')).toHaveLength(1);
    expect(ogers(ctx, 'P3')).toHaveLength(0);
  });

  it('kazuul-gone-the-trigger-still-resolves-for-its-frozen-controller — source gone still resolves', () => {
    const ctx = pod('kazuul-source-gone');
    const kazuul = spawn(ctx, 'P1', kazuulPin.card);
    const verdict = conjure(ctx, 'P1', verdictCard(), 'hand');
    // Real {B} source for the disruption cast; real {3} sources for P2's pay window.
    spawn(ctx, 'P1', swamp());
    const witness = spawn(ctx, 'P2', witnessCard());
    for (let i = 0; i < 3; i++) spawn(ctx, 'P2', forest());
    combatPod(ctx, 'P2');
    const payCount = { n: 0 };
    let verdictCast = false;
    pump(runCombatPhase(ctx), (decision) => {
      if (decision.decisionType === 'declareAttackers')
        return declareAttacks(decision, (id) => (id === witness.id ? 'P1' : null));
      // While Kazuul's trigger is on the stack at the attackers step, P1 destroys its own
      // Kazuul; the trigger keeps resolving under its frozen controller (CR 603.2h).
      if (
        !verdictCast &&
        decision.decisionType === 'priority' &&
        decision.player === 'P1' &&
        ctx.state.step === 'declareAttackers' &&
        ctx.state.stack.length > 0
      ) {
        const index = decision.options.findIndex((option) => {
          const payload = option.payload as PriorityActionPayload | undefined;
          return payload?.kind === 'castSpell' && payload.objectId === verdict.id;
        });
        expect(index).toBeGreaterThanOrEqual(0);
        verdictCast = true;
        return { index, targets: new Map([[0, kazuul.id]]) };
      }
      if (isPayPrompt(decision)) {
        payCount.n += 1;
        return payChoice(decision, 'decline');
      }
      return passOutcome(decision);
    });
    expect(verdictCast).toBe(true);
    expect(ctx.state.battlefield.some((entry) => entry.id === kazuul.id)).toBe(false);
    expect(payCount.n).toBe(1);
    expect(ogers(ctx, 'P1')).toHaveLength(1);
  });

  it('kazuul-payer-is-the-current-controller-after-a-control-change — payer follows a control change', () => {
    const ctx = pod('kazuul-payer-change');
    spawn(ctx, 'P1', kazuulPin.card);
    const witness = spawn(ctx, 'P2', witnessCard());
    witness.attacking = 'P1';
    queueTriggersForEvent(ctx, 'attacks', [{ permanent: witness, playerId: 'P2' }]);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    // The attacker changes controller after the event but before the trigger resolves; the
    // payment is now asked of the event permanent's CURRENT controller (P4), who declines. The
    // intervening-if still holds: its retained defender is the player the attack named.
    changeController(ctx, witness, 'P4');
    addMana(playerById(ctx, 'P4'), [{ symbol: 'C' }, { symbol: 'C' }, { symbol: 'C' }]);
    const payCount = { n: 0 };
    let asked: string | null = null;
    pump(runPrioritySequence(ctx), (decision) => {
      if (isPayPrompt(decision)) {
        payCount.n += 1;
        asked = decision.player;
        return payChoice(decision, 'decline');
      }
      return passOutcome(decision);
    });
    expect(payCount.n).toBe(1);
    // The prompt went to the event permanent's CURRENT controller, not the event player.
    expect(asked).toBe('P4');
    expect(ogers(ctx, 'P1')).toHaveLength(1);
  });

  it('kazuul-planeswalker-attack-still-defended-after-the-walker-leaves — walker leaves, still defended', () => {
    const ctx = pod('kazuul-walker-attack');
    spawn(ctx, 'P1', kazuulPin.card);
    const walker = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Lab Walker',
        typeLine: 'Planeswalker — Lab',
        manaCost: '{2}',
        loyalty: '4',
      }),
    );
    const witness = spawn(ctx, 'P2', witnessCard());
    witness.attacking = 'P1';
    witness.attackingPlaneswalker = walker.id;
    queueTriggersForEvent(ctx, 'attacks', [{ permanent: witness, playerId: 'P2' }]);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    // The attacked planeswalker leaves combat by leaving the battlefield; the attacker stays
    // attacking that player, so Kazuul remains the defending player for the resolution.
    void pump(moveObject(ctx, walker, { zone: 'exile' }));
    const before = ogers(ctx, 'P1').length;
    pump(runPrioritySequence(ctx));
    expect(ogers(ctx, 'P1')).toHaveLength(before + 1);
  });

  it('kazuul-selector-containment — removed attackers do not match the attack selectors', () => {
    const ctx = pod('kazuul-selector-containment');
    spawn(ctx, 'P1', forest());
    const witness = spawn(ctx, 'P2', witnessCard());
    witness.attacking = 'P1';
    const you = ctx.state.battlefield.find((p) => p.name === 'Forest' && p.controllerId === 'P1');
    if (you === undefined) throw new Error('the P1 reference permanent vanished');
    const candidate = () => candidateOf(ctx, witness, computeCharacteristics(ctx, witness), true);
    expect(selectMatches(candidate(), { kind: 'attackingYouOrYourPlaneswalker' }, you)).toBe(true);
    removeFromCombat(ctx, witness);
    // CR 506.4 removal ends the combat assignment: the legacy selector falls silent, and only
    // the retained-defender CONDITION (not a selector) still answers the intervention question.
    expect(selectMatches(candidate(), { kind: 'attackingYouOrYourPlaneswalker' }, you)).toBe(false);
    expect(selectMatches(candidate(), { kind: 'combatRole', role: 'attacking' }, you)).toBe(false);
  });

  for (const { title, defender, expected } of [
    {
      title: 'kazuul-planeswalker-you — ordinary combat declaration against your planeswalker',
      defender: 'P1',
      expected: 1,
    },
    {
      title:
        'kazuul-planeswalker-other — ordinary combat declaration against another player’s planeswalker',
      defender: 'P3',
      expected: 0,
    },
  ] as const) {
    it(title, () => {
      const ctx = pod(title);
      spawn(ctx, 'P1', kazuulPin.card);
      const walker = spawn(
        ctx,
        defender,
        oracle({
          name: 'Cliff Walker',
          typeLine: 'Planeswalker — Cliff',
          loyalty: '4',
        }),
      );
      const attacker = spawn(ctx, 'P2', witnessCard());
      for (let index = 0; index < 3; index++) spawn(ctx, 'P2', forest());
      combatPod(ctx, 'P2');
      let prompts = 0,
        declared = false;
      pump(runCombatPhase(ctx), (decision) => {
        if (decision.decisionType === 'declareAttackers') {
          declared = true;
          expect(decision.options[0]!.targets![0]!.options).toContain(walker.id);
          return declareAttacks(decision, (id) => (id === attacker.id ? walker.id : null));
        }
        if (isPayPrompt(decision)) {
          prompts++;
          return payChoice(decision, 'decline');
        }
        return passOutcome(decision);
      });
      expect(declared).toBe(true);
      expect(prompts).toBe(expected);
      expect(ogers(ctx, 'P1')).toHaveLength(expected);
      expect(walker.counters['loyalty']).toBe(2);
      expect(events(ctx, 'unlessNotPaid')).toHaveLength(expected);
    });
  }
});
