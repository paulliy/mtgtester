/**
 * `voteAndExileMost` — the reusable primitive, proved on printed fixtures that are NOT
 * Council's Judgment.
 *
 * Council's Judgment only pins one selector ("a nonland permanent you don't control"). These
 * tests exist so the primitive cannot quietly become card-specific: two genuinely different
 * printed cards author the same op with different selectors, an ordinary INSTANT is cast from P1
 * while P3 holds priority to separate "starting with you" from APNAP order, and the departure is
 * watched by a permanent leaving in the same event.
 *
 * Every fixture here carries its own printed Oracle text, its own interpreter `handledLines`
 * copied verbatim out of `unmodeledReasons`, and its own derived modeled definition. Nothing is
 * a blank printed spell with `modeled: true` forced on.
 */
import { describe, expect, it } from 'vitest';
import { interactionFor } from '../src/engine';
import type { OracleCard, PlayerId } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import type { CardDefinition } from '../src/cards/definition';
import type { Effect, ManaEntry } from '../src/cards/ability';
import { defineCard } from '../src/cards/overrides';
import { allOf, ofType, OPPONENTS } from '../src/cards/selector';
import { spell } from '../src/cards/templates';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { validateEffectExpressions } from '../src/cards/expression-validation';
import type { AuthoringIssue } from '../src/cards/authoring-validation';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { applyPriorityAction } from '../src/actions/apply';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import type { EffectSource } from '../src/effects/resolve';
import { executeAbility } from '../src/effects/resolve';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { runPrioritySequence } from '../src/turn/priority';
import { addMana } from '../src/mana/pool';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

// --- Custom printed fixtures -------------------------------------------------

/** An instant whose council vote is restricted to ARTIFACTS. */
const BALLOT = oracle({
  name: 'Ballot of Ashes',
  typeLine: 'Instant',
  manaCost: '{1}{R}',
  oracleText:
    "Starting with you, each player votes for an artifact you don't control. Exile each artifact with the most votes or tied for most votes.",
});

/** An instant whose council vote is restricted to CREATURES — a different selector, same primitive. */
const CONCORD = oracle({
  name: 'Concord of Wards',
  typeLine: 'Instant',
  manaCost: '{2}',
  oracleText:
    "Starting with you, each player votes for a creature you don't control. Exile each creature with the most votes or tied for most votes.",
});

/**
 * A watcher whose trigger reads the board while it is itself leaving: an exiled artifact can see
 * the whole simultaneous departure only if the move really is one event.
 */
const SIGHT_LENS = oracle({
  name: 'Sight Lens',
  typeLine: 'Artifact',
  manaCost: '{2}',
  oracleText: 'Whenever an artifact leaves the battlefield, draw a card.',
});

/**
 * The authored definitions. `handledLines` are copied verbatim from the interpreter's own
 * `unmodeledReasons` for these printed texts (nothing else is reported), and the selector is what
 * each card's sentence says — nothing is keyed on the card name.
 */
const ARTIFACT_BALLOT_DEF: Partial<CardDefinition> = {
  spellAbility: spell({
    effects: [{ op: 'voteAndExileMost', selector: allOf(ofType('Artifact'), OPPONENTS) }],
    description:
      'Starting with you, each player votes for an artifact you do not control, then exile each artifact with the most votes or tied for most votes',
  }),
};

const CREATURE_CONCORD_DEF: Partial<CardDefinition> = {
  spellAbility: spell({
    effects: [{ op: 'voteAndExileMost', selector: allOf(ofType('Creature'), OPPONENTS) }],
    description:
      'Starting with you, each player votes for a creature you do not control, then exile each creature with the most votes or tied for most votes',
  }),
};

const HANDLED_BALLOT = [
  'unrecognized rules text: "Starting with you, each player votes for an artifact you don\'t control. Exile each artifact with the most votes or tied for most votes."',
];
const HANDLED_CONCORD = [
  'unrecognized rules text: "Starting with you, each player votes for a creature you don\'t control. Exile each creature with the most votes or tied for most votes."',
];

/**
 * The two custom fixtures go through the REAL registration path — `defineCard`, under both the
 * card's own id and its derived fixture alias — so `modeled: true` is DERIVED from the handled
 * lines matching the interpreter byte-for-byte, never asserted by hand.
 */
defineCard(BALLOT.oracleId, BALLOT.name, HANDLED_BALLOT, ARTIFACT_BALLOT_DEF);
defineCard(CONCORD.oracleId, CONCORD.name, HANDLED_CONCORD, CREATURE_CONCORD_DEF);

/**
 * The interpreter's own reasons for this printed text under an id no override claims. This is the
 * drift guard's evidence: `handledLines` above is a verbatim copy of these, so if the printed
 * sentence is retouched, this assertion fails instead of the fixture quietly keeping its author.
 */
function rawReasons(card: OracleCard): string[] {
  return interpretCard({ ...card, oracleId: `${card.oracleId}-unregistered` }).unmodeledReasons;
}

/** The final definition for a custom fixture, with its modeled state derived from the registry. */
function authored(card: OracleCard, handledLines: string[]) {
  expect(rawReasons(card), 'handledLines is copied verbatim from the interpreter').toEqual(
    handledLines,
  );
  const interpreted = interpretCard(card);
  expect(interpreted.unmodeledReasons).toEqual([]);
  expect(interpreted.modeled).toBe(true);
  expect(interpreted.spellAbility!.targets).toEqual([]);
  expect(interpreted.spellAbility!.effects[0]!.op).toBe('voteAndExileMost');
  expect(validateCardDefinition(interpreted).map((entry) => entry.message)).toEqual([]);
  return interpreted;
}

// --- Harness -----------------------------------------------------------------

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(12, forest) })),
      { seed },
    ),
  );
  // P3 is the ACTIVE player and holds priority; P1 is the caster of the instant below.
  ctx.state.currentTurnPlayer = 'P3';
  ctx.state.activePlayerIndex = 2;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  ctx.state.turnNumber = 5;
  return ctx;
}

function relic(ctx: GameContext, controller: PlayerId, name: string, typeLine: string) {
  return spawn(ctx, controller, oracle({ name, typeLine }));
}

type Answer = (decision: PendingDecision, count: number) => DecisionOutcome;

function voteFor(decision: PendingDecision, name: string, occurrence = 0): DecisionOutcome {
  const matching = decision.options
    .map((option, index) => ({ option, index }))
    .filter(({ option }) => option.description === `Vote for ${name}`);
  expect(matching.length, `${decision.player} can vote for ${name}`).toBeGreaterThan(occurrence);
  return { index: matching[occurrence]!.index, targets: new Map<number, string>() };
}

function byName(picks: Record<PlayerId, string>, occurrence = 0): Answer {
  return (decision) => {
    const wanted = picks[decision.player];
    if (wanted === undefined) throw new Error(`no planned vote for ${decision.player}`);
    return voteFor(decision, wanted, occurrence);
  };
}

/** The card's single authored effect, narrowed to the op under test. */
function voteEffect(def: CardDefinition): Extract<Effect, { op: 'voteAndExileMost' }> {
  const effect = def.spellAbility!.effects[0]!;
  expect(effect.op).toBe('voteAndExileMost');
  return effect as Extract<Effect, { op: 'voteAndExileMost' }>;
}

/** Resolve a card's authored spell ability directly, with a real source object in hand. */
function resolveAuthored(ctx: GameContext, caster: PlayerId, card: OracleCard, answer?: Answer) {
  authored(card, card === BALLOT ? HANDLED_BALLOT : HANDLED_CONCORD);
  const obj = conjure(ctx, caster, card, 'hand');
  const def = ctx.defs.get(card.oracleId)!;
  const source: EffectSource = {
    cardId: obj.cardId,
    name: obj.name,
    oracleId: obj.oracleId,
    controllerId: caster,
  };
  return pump(executeAbility(ctx, source, def.spellAbility!, []), answer);
}

const voteEvents = (ctx: GameContext) =>
  ctx.state.eventLog.filter((event) => event.type === 'vote');
const exileEvents = (ctx: GameContext) =>
  ctx.state.eventLog.filter(
    (event) => event.type === 'zoneChange' && event.payload['to'] === 'exile',
  );
const onBattlefield = (ctx: GameContext, perm: { id: string }) =>
  ctx.state.battlefield.some((candidate) => candidate.id === perm.id);

describe('voteAndExileMost primitive contract', () => {
  it('vote-exile-custom-fixtures-modeled — the two custom printed cards derive modeled state', () => {
    // Without the registration each fixture is unmodeled, with exactly one reported reason —
    // the sentence the override claims to handle.
    expect(interpretCard({ ...BALLOT, oracleId: 'ballot-of-ashes-unregistered' }).modeled).toBe(
      false,
    );
    expect(interpretCard({ ...CONCORD, oracleId: 'concord-of-wards-unregistered' }).modeled).toBe(
      false,
    );
    expect(rawReasons(BALLOT)).toEqual(HANDLED_BALLOT);
    expect(rawReasons(CONCORD)).toEqual(HANDLED_CONCORD);

    const ballot = authored(BALLOT, HANDLED_BALLOT);
    const concord = authored(CONCORD, HANDLED_CONCORD);
    // Both register under their real id AND their derived fixture alias, and both author the
    // same op with genuinely different selectors.
    expect(interpretCard({ ...BALLOT, oracleId: 'oracle-ballot-of-ashes' }).spellAbility).toEqual(
      ballot.spellAbility,
    );
    expect(interpretCard({ ...CONCORD, oracleId: 'oracle-concord-of-wards' }).spellAbility).toEqual(
      concord.spellAbility,
    );
    expect(voteEffect(ballot).selector).not.toEqual(voteEffect(concord).selector);
    expect(voteEffect(ballot).selector).toEqual(allOf(ofType('Artifact'), OPPONENTS));
    expect(voteEffect(concord).selector).toEqual(allOf(ofType('Creature'), OPPONENTS));
  });

  it('vote-exile-authoring-validation — the selector is validated, positively and negatively', () => {
    const good: AuthoringIssue[] = [];
    validateEffectExpressions(
      { op: 'voteAndExileMost', selector: allOf(ofType('Artifact'), OPPONENTS) },
      'effects[0]',
      good,
    );
    expect(good).toEqual([]);

    const missing: AuthoringIssue[] = [];
    validateEffectExpressions({ op: 'voteAndExileMost' } as never, 'effects[0]', missing);
    expect(missing.map((issue) => issue.path)).toEqual(['effects[0].selector']);
    expect(missing[0]!.message).toMatch(/selector/i);

    const malformed: AuthoringIssue[] = [];
    validateEffectExpressions(
      { op: 'voteAndExileMost', selector: { kind: 'type' } } as never,
      'effects[0]',
      malformed,
    );
    expect(malformed.map((issue) => issue.path)).toEqual(['effects[0].selector.value']);
  });

  it('vote-exile-selector-variation — each card offers exactly its own printed candidate pool', () => {
    const ctx = pod('vote-exile-variation');
    const artifact = relic(ctx, 'P2', 'Ash Idol', 'Artifact');
    const creature = relic(ctx, 'P2', 'Ash Hound', 'Creature — Hound');
    const enchantment = relic(ctx, 'P3', 'Ash Seal', 'Enchantment');
    resolveAuthored(ctx, 'P1', BALLOT, (decision) => {
      expect(decision.options.map((option) => option.description)).toEqual(['Vote for Ash Idol']);
      return { index: 0, targets: new Map() };
    });
    expect(onBattlefield(ctx, artifact)).toBe(false);
    expect(onBattlefield(ctx, creature)).toBe(true);
    expect(onBattlefield(ctx, enchantment)).toBe(true);

    const other = pod('vote-exile-variation-2');
    const artifact2 = relic(other, 'P2', 'Warden Idol', 'Artifact');
    const creature2 = relic(other, 'P2', 'Warden Hound', 'Creature — Hound');
    resolveAuthored(other, 'P1', CONCORD, (decision) => {
      expect(decision.options.map((option) => option.description)).toEqual([
        'Vote for Warden Hound',
      ]);
      return { index: 0, targets: new Map() };
    });
    expect(onBattlefield(other, artifact2)).toBe(true);
    expect(onBattlefield(other, creature2)).toBe(false);
  });

  it('vote-exile-instant-from-p1-while-p3-active — voting starts at the caster, not APNAP', () => {
    const ctx = pod('vote-exile-instant');
    const target = relic(ctx, 'P4', 'Quorum Idol', 'Artifact');
    const decoy = relic(ctx, 'P2', 'Decoy Idol', 'Artifact');
    authored(BALLOT, HANDLED_BALLOT);
    const obj = conjure(ctx, 'P1', BALLOT, 'hand');
    const payment: ManaEntry[] = [{ symbol: 'R' }, { symbol: 'C' }];
    addMana(playerById(ctx, 'P1'), payment);
    const option = computePriorityOptions(ctx, playerById(ctx, 'P1')).find((candidate) => {
      const payload = candidate.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === obj.id;
    });
    expect(option, 'an instant is castable out of turn').toBeDefined();

    pump(
      applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(ctx.state.stack).toHaveLength(1);
    expect(ctx.state.currentTurnPlayer).toBe('P3');

    const order: PlayerId[] = [];
    pump(runPrioritySequence(ctx), (decision) => {
      if (decision.decisionType === 'priority') {
        const pass = decision.options.findIndex((candidate) => candidate.type === 'pass');
        return { index: pass >= 0 ? pass : 0, targets: new Map() };
      }
      order.push(decision.player);
      for (const candidate of decision.options) {
        expect(interactionFor(candidate)).toEqual({ kind: 'choice' });
        expect(candidate.payload).toBeUndefined();
        expect(candidate.presentation).toMatchObject({
          verb: 'Vote',
          subjects: [{ kind: 'card', card: { zone: 'battlefield' } }],
        });
      }
      return voteFor(decision, 'Quorum Idol');
    });

    // P3 is the active player; the council still begins with P1, the ability's controller.
    expect(order).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(voteEvents(ctx).map((event) => event.actorSeat)).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(onBattlefield(ctx, target)).toBe(false);
    expect(onBattlefield(ctx, decoy)).toBe(true);
  });

  it('vote-exile-all-decisions-before-movement — nothing leaves until every vote is cast', () => {
    const ctx = pod('vote-exile-ordering');
    const a = relic(ctx, 'P2', 'Quorum Idol', 'Artifact');
    const b = relic(ctx, 'P3', 'Minor Idol', 'Artifact');
    const c = relic(ctx, 'P4', 'Quiet Idol', 'Artifact');
    const { decisions } = resolveAuthored(ctx, 'P1', BALLOT, (decision, count) => {
      expect(exileEvents(ctx)).toEqual([]);
      expect(voteEvents(ctx)).toHaveLength(count - 1);
      for (const perm of [a, b, c]) expect(onBattlefield(ctx, perm)).toBe(true);
      return voteFor(decision, count <= 3 ? 'Quorum Idol' : 'Minor Idol');
    });
    expect(decisions).toHaveLength(4);
    expect(exileEvents(ctx)).toHaveLength(1);
    expect(onBattlefield(ctx, a)).toBe(false);
    expect(onBattlefield(ctx, b)).toBe(true);
    expect(onBattlefield(ctx, c)).toBe(true);
  });

  it('vote-exile-exact-object-ids — two same-name permanents are two separate candidates', () => {
    const ctx = pod('vote-exile-identical');
    const first = relic(ctx, 'P2', 'Twin Idol', 'Artifact');
    const second = relic(ctx, 'P3', 'Twin Idol', 'Artifact');
    const third = relic(ctx, 'P4', 'Lone Idol', 'Artifact');
    expect(first.id).not.toBe(second.id);
    const { decisions } = resolveAuthored(ctx, 'P1', BALLOT, (decision, count) => {
      // Both twins are offered, under one identical description each.
      const twins = decision.options.filter(
        (option) => option.description === 'Vote for Twin Idol',
      );
      expect(twins).toHaveLength(2);
      // P1 and P2 name the first object, P3 and P4 the second.
      return voteFor(decision, count <= 2 ? 'Twin Idol' : 'Twin Idol', count <= 2 ? 0 : 1);
    });
    expect(decisions).toHaveLength(4);
    expect(voteEvents(ctx).map((event) => event.payload['objectId'])).toEqual([
      first.id,
      first.id,
      second.id,
      second.id,
    ]);
    // A tie at two: both twins leave, the lone permanent nobody named stays.
    expect(onBattlefield(ctx, first)).toBe(false);
    expect(onBattlefield(ctx, second)).toBe(false);
    expect(onBattlefield(ctx, third)).toBe(true);
    expect(exileEvents(ctx)).toHaveLength(2);
  });

  it('vote-exile-forced-single-candidate — a one-option vote is engine-forced and still recorded', () => {
    const ctx = pod('vote-exile-forced');
    const only = relic(ctx, 'P2', 'Sole Idol', 'Artifact');
    const { decisions } = resolveAuthored(ctx, 'P1', BALLOT, () => {
      throw new Error('a single-candidate vote is forced and must not be surfaced');
    });
    expect(decisions).toEqual([]);
    const votes = voteEvents(ctx);
    expect(votes.map((event) => event.actorSeat)).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(votes.map((event) => event.payload['objectId'])).toEqual([
      only.id,
      only.id,
      only.id,
      only.id,
    ]);
    expect(onBattlefield(ctx, only)).toBe(false);
  });

  it('vote-exile-simultaneous-departure — a watcher leaving with the others sees the whole event', () => {
    const ctx = pod('vote-exile-simultaneous');
    expect(interpretCard(SIGHT_LENS).unmodeledReasons).toEqual([]);
    const watcher = spawn(ctx, 'P2', SIGHT_LENS);
    const companion = relic(ctx, 'P3', 'Companion Idol', 'Artifact');
    const spared = relic(ctx, 'P4', 'Spared Idol', 'Artifact');
    const handBefore = playerById(ctx, 'P2').hand.length;
    resolveAuthored(
      ctx,
      'P1',
      BALLOT,
      byName({ P1: 'Sight Lens', P2: 'Sight Lens', P3: 'Companion Idol', P4: 'Companion Idol' }),
    );

    // A 2:2 tie, and the watcher is one of the winners: it leaves in the same event as the
    // companion, and nobody who never got a vote touches the board.
    expect(onBattlefield(ctx, watcher)).toBe(false);
    expect(onBattlefield(ctx, companion)).toBe(false);
    expect(onBattlefield(ctx, spared)).toBe(true);
    expect(
      exileEvents(ctx)
        .map((event) => event.payload['name'])
        .sort(),
    ).toEqual(['Companion Idol', 'Sight Lens']);
    // The watcher is FIRST in the affected set and leaves too. Its printed ability must see
    // BOTH artifacts leave. A sequential move loses this watcher before the companion leaves.
    expect(ctx.state.pendingTriggers).toHaveLength(2);

    // Let the trigger go on the stack and resolve. It is put on the stack only AFTER both
    // departures have completed, so the watcher reads a board the whole event has already left.
    pump(runPrioritySequence(ctx));
    const log = ctx.state.eventLog;
    const watcherLeft = log.find(
      (event) => event.type === 'zoneChange' && event.payload['name'] === 'Sight Lens',
    );
    const companionLeft = log.find(
      (event) => event.type === 'zoneChange' && event.payload['name'] === 'Companion Idol',
    );
    expect(watcherLeft).toBeDefined();
    expect(companionLeft).toBeDefined();
    const queued = log.filter((event) => event.type === 'triggerOnStack');
    expect(queued).toHaveLength(2);
    for (const event of queued) {
      expect(watcherLeft!.sequence).toBeLessThan(event.sequence);
      expect(companionLeft!.sequence).toBeLessThan(event.sequence);
    }
    // The watcher itself resolved against the post-departure board, and drew for it.
    expect(playerById(ctx, 'P2').hand).toHaveLength(handBefore + 2);
    expect(onBattlefield(ctx, watcher)).toBe(false);
    expect(onBattlefield(ctx, companion)).toBe(false);
    expect(onBattlefield(ctx, spared)).toBe(true);
  });

  it('vote-exile-no-candidates — an empty pool produces no decision, no vote and no exile', () => {
    const ctx = pod('vote-exile-empty');
    const creature = relic(ctx, 'P2', 'Only Hound', 'Creature — Hound');
    const { decisions } = resolveAuthored(ctx, 'P1', BALLOT, () => {
      throw new Error('an artifact-only pool with no artifacts must not ask anything');
    });
    expect(decisions).toEqual([]);
    expect(voteEvents(ctx)).toEqual([]);
    expect(exileEvents(ctx)).toEqual([]);
    expect(onBattlefield(ctx, creature)).toBe(true);
  });
});
